---
title: "Ten Posts Later: What I'd Do Differently"
description: "Looking back at a collaborative canvas app, the decisions that held up, the ones that didn't, and what's still broken."
date: 2026-05-28
tags: ["engineering", "reflection", "canvas", "collaboration"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 10
---

Nine posts ago I said I thought building a drawing app would be easy. Draw some shapes, take some input, move on.

This is the last one. Time to be honest about what I got right, what I got wrong, and what's still broken in the thing that's running right now.

## One question, nine costumes

Reading the series back, every post is the same question.

Post 2 was “can I avoid rebuilding this path”. Post 3 was “can I avoid storing these points”. Post 6 was “can I avoid sending this cursor position”. Post 7 was “can I avoid buffering this message”. Post 9 was “can I avoid writing this coordinate”.

All of it is: what work can I not do.

The specific techniques were mostly things I looked up. Path caching, viewport culling, RDP simplification, throttling, backoff, none of it is original. What actually changed was the instinct. My first version of anything used to be “make it work, then make it faster”. Now the first version asks what it can skip, because that's usually a bigger factor than making the remaining work fast.

## What held up

**Choosing a CRDT before writing sync code.** This is the decision the whole project rests on. Offline support, reconnect merging, ephemeral rooms and per user undo all came from it, and I only deliberately designed one of those. The rest fell out.

**Two sources of truth, deliberately.** Yjs owns the document, Zustand mirrors it for rendering. It looks like duplication and it's the reason the render loop is simple and local edits are instant. The `transaction.local` guard that makes it safe is one line.

**Deriving instead of storing.** Arrow endpoints computed at render time rather than written on every move. Fewer writes, no stale data, cleaner undo history. Every time I've been tempted to cache a derived value in the document since, that's been the wrong call.

**Splitting document state from ephemeral state.** Cursors, selection and interpolation never touch the CRDT. This one keeps paying out. Almost every awkward bug I hit was something in the wrong category, and once it moved the bug stopped being a bug.

**Writing the protocol by hand.** Not because the library was bad, but because when two tabs disagreed I knew exactly which layer to look at. That was worth more than the three hundred lines cost.

## What I'd do differently

**Build the debug panel first.** There's an overlay showing FPS, frame time, shape count and connection state. I built it around the time I started optimising, which is to say later than every optimisation decision I'd already guessed at. It should have existed before the first shape rendered.

**Add the metrics endpoint on day one.** Same mistake, server side. Every threshold in post 7 was a guess, and they stayed guesses until there were counters to check them against.

**Take the measurements I said I would.** There's a performance baseline doc in the repo with a table of shape counts and timings, and a second table for WebSocket load with every cell still empty. The harness exists. I wrote it and then optimised without running it. That's the thing in this project I'm least happy about, because it means some of what I did was informed and some was folklore, and I can't tell you which is which.

**Read the transport docs before the library docs.** The two worst bugs were `binaryType = 'arraybuffer'` and the uWS buffer being recycled after the callback. Both are documented. Both were silent. Both cost an evening. When you're plugging two libraries together, the failures live at the seam, not inside either one.

**Set the throttle and the rate limit together.** They're two numbers in two packages that only make sense as a pair, and I picked them weeks apart, then had to work backwards to find out why active editing was hitting the limiter. They should have been decided in the same sitting, with a comment in each pointing at the other.

## What's still broken

I'd rather write this down than pretend it's finished.

**Dropped sync messages need a reconnect to repair.** Post 7 covered this. Under sustained backpressure a client can miss an update and there's no automatic catch up. The fix is per client state vectors and targeted diffs instead of blind rebroadcast.

**Tombstones grow forever.** A CRDT remembers deletions. A room used heavily for long enough accumulates metadata for content nobody can see. It's not a problem at whiteboard scale and it's a real one at document scale.

**There's no persistence beyond the browser.** Clear your storage and it's gone. The upgrade path is clean, snapshot the room doc before destroying it, load it in `getOrCreate`, and the client wouldn't change at all. I just haven't needed it.

**No auth.** Anyone with the URL is in. That's a deliberate choice for a share-a-link tool and it's also a limitation you'd have to remove before it's anything else.

**The performance table is still half empty.** See above.

## The thing I actually learned

The most useful shift was starting to treat the frontend as a system with a budget rather than a set of features.

A frame has a budget. A socket has a budget. A rate limiter is a budget written down. Once you're thinking that way, the questions change from “is this fast enough” to “what am I spending this on, and what am I willing to drop when I run out”.

And you do run out. Every limit in this project is really a decision about what to sacrifice under pressure. The cursor position you skip. The message you drop. The point you remove from a stroke. Making those choices explicitly is most of what separated the version that worked from the version that felt good.

The default is also a choice. Unbounded buffering, unthrottled input, redrawing everything every frame. Those are all decisions. They just make themselves, and they're usually the wrong ones.

## Closing

Ten posts on a whiteboard app is more than the app deserves and about right for what it taught me.

If you're building something similar, the order I'd suggest is: pick your data model first and let it be the thing that solves your hard problems, instrument before you optimise, and be clear with yourself about which state is precious and which is disposable. Almost everything in this series is a consequence of those three.

You can try the project here:  
👉 https://canvas.mohith16.com/

Thanks for reading through the whole series.
