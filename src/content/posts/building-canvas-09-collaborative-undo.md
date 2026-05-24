---
title: "Undo Is a Stack of Your Own Mistakes"
description: "Ctrl+Z is trivial in a single user app. Add one collaborator and the obvious implementation starts erasing other people's work."
date: 2026-05-24
tags: ["frontend", "collaboration", "crdt", "ux"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 9
---

Undo in a single user app is a first week feature. Keep a stack, push the inverse of each operation, pop on Ctrl+Z.

Add a second person to the canvas and that implementation becomes actively harmful.

## The failure is immediate

Two users in a room. A draws a rectangle. B draws a circle. A presses Ctrl+Z.

With a global stack, A just deleted B's circle.

A didn't mean to. From A's point of view they undid “the last thing”, and the last thing genuinely was B's circle. The stack was correct and the behaviour was wrong.

There's a worse version. A moves a shape, B moves the same shape, A presses Ctrl+Z. The inverse operation says “put it back at the old position”, but the old position was computed against a state that no longer exists. The shape jumps somewhere neither of them expects.

## What users actually mean

Nobody presses Ctrl+Z expecting to undo the last global event. They expect to undo *their* last action.

That's the whole specification, and it's the thing a global stack cannot express:

- Undo affects only your own changes  
- Your changes stay undoable even if someone else has edited since  
- Undoing your old change does not revert anyone else's newer change  

The last one is the interesting constraint. If A draws a rectangle, B moves it, and A undoes, the rectangle should disappear without B's move being replayed or reverted. The operations are independent, so undoing one shouldn't touch the other.

That is exactly what the CRDT from post four is already tracking.

## Origins do the work

Yjs has an `UndoManager` that operates on this directly. The entire setup is twelve lines:

```ts
export const undoManager = new Y.UndoManager(getShapesMap(), {
  captureTimeout: 500,
  trackedOrigins: new Set([null]),
})
```

`trackedOrigins` is the whole trick.

Every Yjs transaction carries an origin. Local edits, made through `ydoc.transact()` with nothing specified, have an origin of `null`. Updates arriving from the WebSocket provider are applied with the provider as origin, because that's what post four passed in:

```ts
syncProtocol.readSyncMessage(dec, replyEnc, ydoc, this)
```

That `this` at the end is the provider. It was there to stop the client echoing server updates straight back. It turns out to also be the thing that makes collaborative undo work, for free.

Track `null`, and you track exactly the changes this user made. Remote work is excluded automatically, not by a filter someone remembered to write, but because it structurally never enters the tracked set.

> Undo isn't a stack of operations. It's a stack of yours, and the only reliable way to know which are yours is to have labelled them when they happened.

## Grouping

`captureTimeout: 500` is the second half.

A shape being dragged doesn't produce one change. It produces a stream of them. Without grouping, undo walks the shape backwards a few pixels at a time and the user has to hold Ctrl+Z to get anywhere.

500ms means changes within half a second of each other collapse into one undo entry. A drag becomes one step. A pause becomes a boundary.

The number is a judgement call. Too short and a slow deliberate drag splits into pieces. Too long and two genuinely separate edits get welded together, which is worse, because the user sees more disappear than they asked for.

Half a second is short enough that it never merges things a person thinks of as separate.

## One user action, several document changes

Here's where it stopped being a library feature and started needing thought.

Deleting a shape is not one map entry. Arrows can be bound to shapes, and an arrow bound to a shape that no longer exists is broken. So deleting has to unbind them:

```ts
export function removeShape(id: string): void {
  const { shapes } = useShapeStore.getState()

  ydoc.transact(() => {
    getShapesMap().delete(id)

    // Unbind any arrows whose endpoints were bound to this shape
    for (const shape of Object.values(shapes)) {
      if (shape.type !== 'arrow') continue
      if (shape.fromShapeId !== id && shape.toShapeId !== id) continue

      const patched = { ...shape }
      if (patched.fromShapeId === id) {
        delete patched.fromShapeId
        delete patched.fromAnchor
      }
      if (patched.toShapeId === id) {
        delete patched.toShapeId
        delete patched.toAnchor
      }
      getShapesMap().set(shape.id, patched)
    }
  })

  useShapeStore.getState()._deleteShape(id)
  invalidateFreehandPath(id)
}
```

The single `transact()` wrapping all of it is the point.

One transaction is one undo entry. Undo restores the shape and rebinds every arrow, together, in one keystroke. Split it into separate transactions and the user has to press Ctrl+Z four times to reverse one delete, watching arrows reattach one at a time.

The rule that came out of this: transaction boundaries are undo boundaries, so they should match what the user thinks of as a single action, not what's convenient to write.

## Binding at render time keeps history clean

A related decision that paid off here.

An arrow bound to two shapes could store absolute endpoints and rewrite them whenever a bound shape moves. That's the obvious approach and it's expensive in a way that isn't about CPU.

Instead the binding is stored and the endpoints are resolved when drawing:

```ts
export function resolveArrowEndpoints(
  arrow: Shape,
): [[number, number], [number, number]] {
  const { shapes } = useShapeStore.getState()

  let start: [number, number] = arrow.points?.[0] ?? [arrow.x, arrow.y]

  if (arrow.fromShapeId) {
    const s = shapes[arrow.fromShapeId]
    if (s) {
      const a = arrow.fromAnchor ?? { x: 0.5, y: 0.5 }
      start = [s.x + s.width * a.x, s.y + s.height * a.y]
    }
  }
  ...
}
```

Moving a shape writes to that shape and nothing else. The arrow follows because it's computed, not stored.

Three things fall out of that. Fewer document writes, so less sync traffic. No stale coordinates, because there are none to go stale. And the undo history stays readable, because dragging a rectangle with five arrows attached produces one entry rather than six.

It also connects back to the first three posts. Deriving instead of storing is the same instinct as caching a path instead of rebuilding it, pointed at the data model rather than the render loop.

## The parts undo shouldn't touch

Deleting a shape also has effects outside the document:

```ts
useSelectionStore.getState().removeFromSelection(key)
clearRemoteLerpPos(key)
```

Selection and interpolation state. Neither lives in the CRDT, both need clearing when a shape goes away.

And crucially, neither comes back on undo. Restore a deleted shape and it reappears unselected. That's correct. Selection is per user and transient, in the same category as cursors from post six. Restoring someone else's selection along with the shape would be strange.

The category split from the presence post keeps reappearing. Document state, which is shared, persisted and undoable. Ephemeral state, which is local, disposable and outside history. Almost every awkward bug in this project came from something sitting in the wrong category.

## Wiring it to buttons

Undo and redo buttons need to know whether they're enabled, which means reading stack depth, which changes on its own:

```ts
const [undoLen, setUndoLen] = useState(undoManager.undoStack.length)
const [redoLen, setRedoLen] = useState(undoManager.redoStack.length)

useEffect(() => {
  const update = () => {
    setUndoLen(undoManager.undoStack.length)
    setRedoLen(undoManager.redoStack.length)
  }
  undoManager.on('stack-item-added', update)
  undoManager.on('stack-item-popped', update)
  undoManager.on('stack-item-updated', update)
  return () => {
    undoManager.off('stack-item-added', update)
    undoManager.off('stack-item-popped', update)
    undoManager.off('stack-item-updated', update)
  }
}, [])
```

`stack-item-updated` is the one that's easy to miss. It fires when a change merges into the existing entry through `captureTimeout`, and without it the button state drifts out of sync during a drag.

## Closing thoughts

This was the feature where the CRDT stopped feeling like a sync mechanism and started feeling like a data model.

Nothing here required tracking who owns what, or diffing states, or reconciling conflicting inverse operations. The information needed for correct collaborative undo was already in the document, because every change carried an origin from the moment it was made.

The lesson isn't about Yjs. It's that a decision made for one reason in post four, tagging updates with their source to stop an echo, turned out to be the foundation for a feature I hadn't thought about yet. That happens more often with good data models than with clever code.

One post left. I'll look back at the whole thing, what still doesn't work, and what I'd do differently starting over.
