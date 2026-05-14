---
title: "Cursors Are Not Part of the Document"
description: "Presence looks like the easiest feature in a collaborative app. It has the tightest constraints of anything in the system."
date: 2026-05-14
tags: ["frontend", "collaboration", "performance", "canvas"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 6
---

The protocol has two message types. The last post covered the first one.

This post is about the second one, and about a decision that seems arbitrary until you try the alternative.

## The tempting mistake

Cursor positions feel like state. Every user has one, it changes, other people need to see it. So put it in the shared document with everything else.

Try it and you find out why nobody does.

The document is persisted to IndexedDB, so now you're writing cursor positions to disk sixty times a second. The document is a CRDT, so every position is a change that has to merge and leaves metadata behind. Undo tracks document changes, so pressing Ctrl+Z rewinds somebody's mouse. And a user who left three days ago still has a cursor in your document, because CRDTs don't forget.

None of that is a bug in the CRDT. It's doing exactly what it promised. The problem is that cursor data has none of the properties that make a document worth storing.

> Document state is worth keeping. Presence is worthless one second later, and pretending otherwise costs you everywhere.

## A separate channel

Yjs has a concept for this called awareness. Same connection, different message type, and none of it touches the doc.

Awareness state is ephemeral by construction. It's keyed by client id, it disappears when the client disconnects, it isn't persisted, and it isn't part of undo history.

Setting it looks like state management, which is the point:

```ts
awareness.setLocalState({
  userId: localUserId,
  color: localColor,
  cursor: null,
  name: localName,
})
```

And then per field, as things change:

```ts
awareness.setLocalStateField('cursor', { x, y })
```

The provider picks that up, encodes it as an awareness message, and the server broadcasts it to the room. Nothing is stored anywhere.

## The volume problem

Here's what makes presence harder than it looks.

`pointermove` fires as fast as the device can produce events. On a decent screen that's 60 to 120 times a second. If every one becomes an awareness message, one user moving their mouse is a sustained flood on the socket.

And they're not alone on it. Shape updates are going out on the same connection.

The rate limiter on the server is a token bucket, 300 tokens refilling over 5 seconds, so 60 messages per second steady state with a burst budget for the initial handshake. An unthrottled pointer eats the entire budget by itself, and then the actual drawing starts getting rejected.

So cursor updates get throttled to roughly 30 per second:

```ts
const sendCursor = throttle(
  (x: number, y: number) => {
    awareness.setLocalStateField('cursor', { x, y })
  },
  33,
  { leading: true, trailing: true },
)
```

33ms. Leading edge so the first movement is immediate, trailing edge so the final resting position always gets sent. Without trailing, the cursor stops a few pixels short of where the user actually left it and stays there.

That leaves roughly 30 messages a second for shape sync, which is about what active editing produces. The numbers were chosen to fit each other, not picked separately.

The viewport goes through the same treatment, because follow mode needs to know where other people are looking, and panning generates events just as fast as moving.

## Thirty updates a second looks broken

Halving the update rate solves the network problem and creates a visual one.

A cursor that jumps to a new position every 33ms doesn't look like a cursor. It looks like something teleporting. The eye is unreasonably good at spotting this.

The fix is to stop drawing the position you received and start drawing toward it:

```ts
const _cursorPos    = new Map<string, { x: number; y: number }>()
const _cursorTarget = new Map<string, { x: number; y: number }>()
const CURSOR_LERP = 0.3

export function markCursorUpdate(userId: string, wx: number, wy: number): void {
  _cursorTarget.set(userId, { x: wx, y: wy })
  if (!_cursorPos.has(userId)) {
    _cursorPos.set(userId, { x: wx, y: wy })   // snap on first appearance
  }
}
```

Received positions are targets. The rendered position moves a fraction of the way toward the target every frame. Network rate and frame rate stop being the same number.

The snap on first appearance matters. Without it a user joining the room gets their cursor animated in from wherever the origin happens to be, which looks like a bug even though it's the interpolation working correctly.

The same technique is used for shapes being dragged by remote users, at a slightly slower factor. Local shapes always render at their exact position, because for the person holding the mouse any smoothing at all reads as lag.

## Cursors need their own frame loop

The canvas only redraws when something changes. That's the whole point of the first three posts in this series.

But an interpolating cursor changes every frame by definition, and if nothing else is happening the canvas is idle and the cursor freezes halfway to its target.

So presence gets a loop of its own:

```ts
export function startCursorLoop(requestRender: () => void): () => void {
  function tick() {
    if (Object.keys(usePresenceStore.getState().remoteUsers).length > 0) {
      requestRender()
    }
    _cursorRafId = requestAnimationFrame(tick)
  }
  ...
}
```

The condition is doing real work. Alone in a room, `remoteUsers` is empty, no render is requested, and the canvas stays idle exactly as before. The continuous loop only exists while somebody is there to justify it.

This is the one place in the app where I deliberately added per frame work back in. It's fine because it's conditional on the thing that makes it necessary.

## Cleanup is most of the feature

The happy path is short. The rest is people leaving.

**Disconnect.** Remove local awareness state so the cursor vanishes for everyone else, and clear the interpolation entry so a rejoin snaps rather than animating in from a stale position.

**Tab hidden.** Set cursor to null on `visibilitychange`. A user who switched tabs isn't pointing at anything, and leaving a frozen cursor on the canvas is worse than showing nothing.

**Pointer leave.** Flush the throttle first, then clear. Flushing sends the last real position, and without it the trailing call fires after the clear and resurrects the cursor.

**Reconnect.** Wipe every remote cursor. They'll come back through awareness within a second, and anything still on screen from before the disconnect is a lie.

**Following someone who left.** Follow mode has to be cancelled when the target disconnects, or the viewport is locked to a user who no longer exists.

Every one of these is a small handler. Collectively they're the difference between presence that feels alive and presence that accumulates ghosts.

## The general shape of it

Presence inverts the priorities of everything else in this series.

The document has to be correct, and it can take its time. Presence has to be immediate, and it's allowed to be slightly wrong. A cursor 30ms behind is fine. A cursor that arrives late, or lingers after someone leaves, is not.

Once I stopped treating it as a smaller version of document sync, the design questions got easy. Different lifetime, different channel, different loop, different tolerance for error.

## Closing thoughts

It's the feature users notice first and the one I underestimated hardest. Not because any individual piece is difficult, but because it's the only part of the system where being fast and being disposable are both requirements.

Everything so far has been client side. In the next post I'll cross to the server and look at what happens when one client in a room can't keep up with the others, which is where backpressure stops being a word from a textbook.
