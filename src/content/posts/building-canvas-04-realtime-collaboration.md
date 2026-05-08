---
title: "Real-Time Collaboration Is Not Just Sending Updates"
description: "Two people editing the same canvas is not a networking problem. It's an agreement problem."
date: 2026-05-08
tags: ["frontend", "collaboration", "crdt", "canvas"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 4
---

The last three posts were about one browser tab.

Cost per frame, cached paths, fewer points. All of it was about a single client doing less work.

Collaboration breaks that framing completely. Suddenly the question isn't “how fast can I draw this”, it's “whose version of the drawing is correct”.

## The obvious first attempt

The first thing everyone tries looks like this:

```ts
socket.send(JSON.stringify({ type: 'update', shape }))
```

And on the other side:

```ts
socket.onmessage = (e) => {
  const { shape } = JSON.parse(e.data)
  shapes[shape.id] = shape
}
```

This works. You open two tabs, you drag a rectangle, it moves in both. It feels like the problem is solved.

It isn't.

## Where it falls apart

Two users move the same shape at nearly the same time.

- User A's update reaches the server first  
- User B's update reaches the server second  
- But B's update reaches A *before* A's own update is echoed back  

Now A sees B's position, then their own, then B's again. The shape jitters and settles somewhere neither of them chose.

The messages were all delivered. Nothing was dropped. The system is still wrong.

Under load it gets worse:
- Updates arrive out of order  
- A slow client applies a stale update on top of a fresh one  
- Someone reconnects and has no idea what they missed  

Every one of these is a state problem wearing a networking costume.

## Changing the question

The naive model treats the socket as the source of truth. Whatever arrived last wins.

But “last” isn't a real thing in a distributed system. Last according to whom? The sender's clock? The server's? The order they happened to land on one particular client?

> Collaboration isn't about delivering changes faster. It's about making the order they arrive in stop mattering.

That is the actual requirement. Once you state it that way, message passing stops being the answer.

## Letting the data structure handle it

A CRDT is a data structure built for exactly this. Concurrent edits merge, and every client that has seen the same set of edits ends up with the same result, no matter what order they saw them in.

The canvas uses Yjs for this. Shapes live in a shared map keyed by id:

```ts
export const ydoc = new Y.Doc()

export function getShapesMap(): Y.Map<Shape> {
  return ydoc.getMap<Shape>('shapes')
}
```

Writing a shape is a transaction on that map:

```ts
ydoc.transact(() => {
  getShapesMap().set(shape.id, shape)
})
```

What goes over the wire is no longer “here is a shape”. It's a Yjs update, a binary diff describing what changed in the document. The receiving client applies it and converges. Nobody has to decide who won.

## Two sources of truth, on purpose

Here's the part that surprised me.

Yjs owns the document, but the render loop does not read from Yjs.

Reading out of a CRDT on every frame is not something you want in a hot path. The renderer needs a plain object it can iterate without thinking about it. So the app keeps a Zustand store mirroring the shapes, and the CRDT feeds it:

```ts
shapesMap.observe((event, transaction) => {
  if (transaction.local) return

  event.changes.keys.forEach((change, key) => {
    if (change.action === 'delete') {
      useShapeStore.getState()._deleteShape(key)
      return
    }
    const shape = shapesMap.get(key)
    if (shape) useShapeStore.getState()._upsertShape(shape)
  })
})
```

The `transaction.local` check matters more than it looks.

## Don't make the local user wait

If every local edit went to Yjs, then to the observer, then to Zustand, then to the renderer, the person dragging a shape would be watching their own input come back to them through a pipeline.

So local writes take a shortcut. Write to Yjs so it propagates, and update the store directly at the same time:

```ts
export function updateShape(id: string, patch: Partial<Omit<Shape, 'id'>>): void {
  const current = useShapeStore.getState().shapes[id]
  if (!current) return

  const updated: Shape = { ...current, ...patch }

  ydoc.transact(() => {
    getShapesMap().set(id, updated)
  })

  useShapeStore.getState()._upsertShape(updated)
}
```

The observer then skips it, because that transaction was local and the store already has it. Without that guard you get a double update on every single edit.

Local feedback is instant. Remote feedback is eventually correct. Those are different requirements and they get different paths.

## What this buys you for free

Once the document is a CRDT rather than a stream of commands, a few things stop being features you build:

**Reload survives.** The doc is persisted to IndexedDB. Refresh the page and the shapes are still there, before the socket has even connected.

**Reconnect merges.** A client that was offline for a minute doesn't need a replay log. It has its own copy of the document, the server has another, and the two are merged on handshake.

**The server holds nothing precious.** Rooms are in memory. When the last client leaves, the doc is thrown away. The next client to join pushes its local state into a fresh server doc and the room is back.

None of that was designed separately. It falls out of choosing a structure where merging is defined.

## The tradeoff

CRDTs are not free.

The document carries metadata so it can merge, which means it's bigger than the shapes alone. Deleted content leaves tombstones behind. And you give up the ability to say “this specific write wins”, because the whole point is that no single write is privileged.

For a whiteboard that's a good deal. Nobody is doing accounting on it. Two people moving the same rectangle just needs to land somewhere sensible and stay there.

## Closing thoughts

The first three posts were about doing less work.

This one is about doing work in an order you can't control, and building something that doesn't care.

The mental shift is small but it changes everything downstream. Stop thinking about messages. Start thinking about a document that several people happen to be holding.

In the next post I'll go a level lower, into what actually travels over that WebSocket, and why I ended up writing the protocol by hand instead of using the library that already exists for it.
