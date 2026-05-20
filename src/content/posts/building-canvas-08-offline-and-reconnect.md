---
title: "The Server Forgets Everything and That's Fine"
description: "Rooms live in memory and get thrown away. The client is the persistence layer, which changes what reconnecting means."
date: 2026-05-20
tags: ["frontend", "backend", "crdt", "reliability"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 8
---

There's no database in this project.

Rooms are a `Map` in server memory. When the last client in a room disconnects, the document is destroyed:

```ts
if (room.isEmpty) {
  roomManager.deleteRoom(roomId)
}
```

That looks like a bug waiting to happen. Everyone closes their tab, the drawing is gone.

Except it isn't, and understanding why is the most useful thing I got out of building this.

## The client is the database

The Y.Doc is persisted to IndexedDB on every client:

```ts
export const persistence = new IndexeddbPersistence('canvas-draw-v1', ydoc)
```

Eight lines including the comment. y-indexeddb watches the doc and writes updates as they happen.

So the drawing isn't stored in one place. It's stored in every browser that has ever been in the room. The server is a relay that happens to hold a copy while people are connected.

When the room comes back, whoever joins first pushes their local state into a fresh, empty server doc through the normal handshake. The state vector exchange from post five does all the work. Nobody wrote restore logic.

This only works because the document is a CRDT. If it were a command log you'd need an authoritative ordering and therefore an authoritative place to keep it. Merging removes the need for a single copy to be special.

## Boot order matters more than it looks

Because local state is the starting point, the app restores before it renders:

```ts
async function init() {
  // 1. Restore Y.Doc from IndexedDB before rendering
  await persistence.whenSynced

  // 2. Populate Zustand with the restored Yjs state
  const shapesMap = getShapesMap()
  useShapeStore.getState()._setShapes(Object.fromEntries(shapesMap.entries()))

  // 3. Wire the Yjs → Zustand observer bridge
  initShapeStoreSync()

  // 4. Mount React. Canvas renders immediately with restored local state
  createRoot(rootEl).render(...)
}
```

Four steps and the order is load bearing.

Mount before `whenSynced` resolves and the user sees an empty canvas that fills in a moment later. Wire the observer before populating the store and you process a burst of change events for state you were about to set wholesale anyway.

The payoff is that the canvas is drawn and usable before the WebSocket has finished connecting. Offline isn't a degraded mode you fall back into. It's the state the app starts in, every single time, and the socket is an enhancement that arrives shortly after.

> Offline isn't a failure you handle. It's the default, occasionally interrupted by connectivity.

## Reconnecting without a stampede

The socket will drop. Laptop sleeps, tunnel, server deploy. Reconnecting is not optional.

The naive version retries on a fixed interval, and it's fine with one user. Now deploy the server while forty people are connected. All forty disconnect at the same instant and all forty retry at the same instant, repeatedly, against a process that's still starting up.

The fix is exponential backoff, and the part people leave out is the jitter:

```ts
export function computeJitteredBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: number = Math.random(),
): number {
  const exp = Math.max(0, attempt - 1)
  const base = Math.min(maxDelayMs, baseDelayMs * 2 ** exp)
  const jitterMultiplier = 1 - jitterRatio + random * 2 * jitterRatio
  return Math.max(0, Math.floor(base * jitterMultiplier))
}
```

Base delay 1 second, cap 30 seconds, jitter ratio 0.3. Every client's delay lands somewhere in a window 30% either side of the nominal value, so the retries spread out instead of arriving as a wall.

Backoff alone doesn't fix the stampede. It just makes the stampede periodic. Jitter is what breaks up the synchronisation.

Passing `random` as a parameter with a default is a small thing that made this testable. You can assert the exact delay for a given attempt without stubbing globals.

## Retrying forever is its own failure

The retry count is capped at 20, and after that the provider stops and reports it:

```ts
if (this.reconnectAttempt >= this.maxReconnectAttempts) {
  useUiStore.getState().setWsReconnectMeta({
    attempt: this.reconnectAttempt,
    nextRetryMs: null,
    maxAttempts: this.maxReconnectAttempts,
    exhausted: true,
  })
  return
}
```

Twenty attempts with this curve is a long time. If it hasn't worked by then, something is wrong that retrying won't fix.

The reconnect metadata goes into the UI store rather than being logged, so the interface can say which attempt it's on and how long until the next one. A user who can see “retrying in 8s, attempt 4 of 20” understands what's happening. A silently retrying app just looks broken.

And the local state is still there and still editable the whole time. That's the part that makes it tolerable.

## Four states, not two

Connected and disconnected isn't enough:

```ts
export type WsState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'SYNCED'
```

`HANDSHAKING` is the one that earns its place. The socket is open, but the state vector exchange hasn't finished, so you don't yet know what you're missing. Treating that as “connected” means showing a collaboration indicator while the document is still incomplete.

`SYNCED` is set when the client receives sync message type 1, which is the reply telling it what it didn't have. At that point the store gets refreshed in case the server had shapes the client didn't:

```ts
if (syncMsgType === 1) {
  this.setState('SYNCED')
  const shapes: Record<string, Shape> = {}
  for (const [id, shape] of getShapesMap().entries()) {
    shapes[id] = shape
  }
  useShapeStore.getState()._setShapes(shapes)
}
```

## The bugs that live in reconnect code

Three that cost real time.

**The zombie socket.** Reconnecting means opening a new socket, which means closing the old one. Closing the old one fires its `onclose`, which schedules a reconnect, which opens another socket. You end up with a growing pile of connections, each one spawning more.

The fix is to detach the handlers before closing, so the old socket can't talk back:

```ts
if (this.ws) {
  const old = this.ws
  this.ws = null
  old.onopen = null
  old.onmessage = null
  old.onerror = null
  old.onclose = null
  try { old.close(1000, 'reconnecting') } catch { /* ignore */ }
}
```

Nulling `this.ws` first matters as well, otherwise the old handler can overwrite the new socket you're about to assign.

**React Strict Mode.** In development, effects mount, unmount and mount again. Without a guard, `connect()` tears down a perfectly good socket and rebuilds it every time. So connect is idempotent for the same room:

```ts
if (
  this.roomId === roomId &&
  this.ws !== null &&
  (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
) {
  return
}
```

**Stale presence.** Document state survives a disconnect. Presence must not. Every remote cursor on screen when the socket drops is a claim about where someone is right now, and it's already false.

So on close, the local awareness entry is removed, the presence store is cleared, and the cursor interpolation state is wiped. They all come back within a second of reconnecting, through awareness, which is the correct source for them.

This is the same split from post six showing up again. Different lifetimes need different handling at every boundary, and a disconnect is a boundary.

## What this design gives up

Being honest about the tradeoff.

If every client clears its browser storage, the drawing is gone. There's no backup.

If two clients edit while both are offline and one never reconnects, that one's work never merges in. Its updates exist only in a browser nobody opens.

And the “last client to leave” has no special status, which sounds fine until you realise it means there's no moment where the document is definitively saved. It's saved in several places, always partially, forever.

For a URL you share with three people for twenty minutes, that's a good trade. It removes a database, a schema, a migration story and an entire class of operational work. For anything people expect to still exist next year, you'd want the server to persist the doc, and the nice part is that this is an additive change. Snapshot the room doc before destroying it, load it in `getOrCreate`. The client side wouldn't change at all.

## Closing thoughts

Deleting the room on empty felt reckless when I wrote it. It's the line that best explains the architecture.

Once the document can merge with itself, “where is the truth” stops being a question with one answer. The server holds a copy because that's convenient for relaying. Every client holds a copy because that's what makes it work offline. None of them is authoritative and nothing needs one to be.

In the next post: undo. Which sounds like a solved problem until two people are editing, and then it turns out the stack you built is undoing the wrong person's work.
