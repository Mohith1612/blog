---
title: "Backpressure, and a Cancel That Doesn't Cancel"
description: "A bounded queue forces you to decide who waits. Cancellation forces you to decide what an error means."
date: 2026-07-21
tags: ["backend", "go", "concurrency", "reliability"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 5
---

The last post put a queue between callers and the disk. That queue has a capacity, and deciding what happens when it fills is a real design decision.

This post is about that, and about a bug I found in the same twenty lines while writing it up.

## Unbounded queues are not queues

The default in most code is a channel or slice with no limit.

That works until producers outrun the consumer, which is exactly what happens here: writers are memory-speed, the writer goroutine is disk-speed, and the gap is four orders of magnitude. An unbounded queue in that situation isn't absorbing a burst. It's accumulating a backlog until the process dies.

And it fails in the worst possible way. Everything looks fine, latency is excellent, `Append` returns instantly, right up until the OOM killer arrives. The queue reports success for writes that will never reach disk.

So the queue is bounded, default depth 4,096, and someone has to be told no.

## Three ways to wait

```go
timer := time.NewTimer(b.cfg.SubmitTimeout)
defer timer.Stop()
select {
case b.queue <- req:
    b.queueDepth.Add(1)
case <-timer.C:
    return ErrEngineOverloaded
case <-ctx.Done():
    return ctx.Err()
case <-b.stopCh:
    return ErrClosed
}
```

Four cases, three of them failures, and each says something different.

`ErrEngineOverloaded` means the engine is behind and you should back off. `ctx.Err()` means the caller gave up. `ErrClosed` means the engine is shutting down and there's no point retrying.

Distinguishing those matters, because the correct client response is different for each. A single generic error would leave the caller guessing about whether to retry.

`ErrEngineOverloaded` is the interesting one. It's an honest admission that the engine cannot keep up, delivered fast. The alternative is stalling the caller for however long the backlog takes to drain, which is worse: they can't make a decision, they can't shed load upstream, and they can't tell the difference between slow and broken.

Backpressure is telling the truth about your capacity, early enough that someone can act on it.

## Then the request is queued, and this happens

Once the request is on the queue, the caller waits for it to be written:

```go
select {
case <-req.Done:
    return req.Err
case <-ctx.Done():
    return ctx.Err()
}
```

Six lines. There's a bug in them.

If the context expires while waiting for `Done`, `Submit` returns `ctx.Err()`. The caller sees a failure.

But the request is still in the channel. Nothing removed it. The writer goroutine will pick it up on the next flush, encode it, write it, and fsync it.

**The caller gets an error and the record is durably written anyway.**

## Why this is worse than it sounds

The caller now cannot make a correct decision.

They received an error, so the natural response is to retry. If the original write did land, the retry is a duplicate mutation. If it didn't, not retrying loses the write. There's no way to tell which happened, and no API that would let them ask.

Post 3 makes it worse. That failed call already consumed an LSN from the atomic counter. The LSN isn't stored on disk, so recovery reconstructs positions contiguously and closes the gap. Even the sequence numbers won't tell you afterwards that anything was ambiguous.

The engine's contract is supposed to be that an error means the operation did not occur. What it actually provides here is *the operation may or may not have occurred, and you will never find out*.

> Returning early isn't cancellation. It's just you leaving. Cancellation requires something that can un-queue the work, and a channel send has no undo.

## Why it isn't a two-line fix

The obvious patch is a cancelled flag on the request that the writer checks before encoding.

That helps, and it doesn't close the window. The writer might already have drained the request and encoded it into the batch buffer when the flag gets set. Now you need the flag checked at a point that's synchronised with encoding, which means either a lock on the batch or an atomic checked at exactly the right moment, and you're building a small state machine around each request.

The honest options:

**Document it.** Say plainly that a context error on a queued request means the outcome is unknown, and that callers need idempotent operations or their own deduplication. Cheap, and it makes the ambiguity the caller's to handle deliberately rather than by accident.

**Don't allow it.** Once a request is queued, ignore the context and always wait for `Done`. The caller can't cancel what's already committed to. This is what I'd probably choose, since a WAL append is short and the ambiguity costs more than the wait.

**Make it two-phase.** Reserve, then commit, with the ability to abandon a reservation. Correct, and much more machinery than this engine needs.

What the code does now is the fourth option, which is to have the API say one thing and the storage do another.

## The parts that are right

Not everything in this file is a cautionary tale.

`Submit` creates the `Done` channel per request, so a caller waits only on their own completion and there's no broadcast wakeup for everybody on every flush.

`Stop()` drains the queue and flushes before stopping the goroutine, so a graceful shutdown doesn't drop queued work.

`queueDepth` is tracked as an atomic and exposed through the metrics, which means "is the engine falling behind" is a number you can graph rather than something you infer from latency.

And `TrySubmit` exists as a non-blocking variant that returns `ErrQueueFull` immediately. For a caller that would rather drop a write than wait, that's the right primitive to offer rather than making them race a timer themselves.

## Closing thoughts

The bounded queue is the correct decision and I'd make it again. The interesting part is that bounding a queue doesn't remove a problem, it converts one. Unbounded queues fail invisibly and catastrophically. Bounded queues fail visibly and locally, and force you to name the failure.

The cancellation bug is a different species. It's not a missing feature, it's a place where the API's contract and the implementation's behaviour drifted apart, in code short enough to read in one screen. I've read that select statement many times and only saw it when I sat down to explain what it guaranteed.

That keeps happening. Writing down what something promises is a much better bug-finding technique than reading what it does.

In the next post: why one file isn't enough, and a durability bug where the engine fsyncs a file that doesn't contain the data it just acknowledged.
