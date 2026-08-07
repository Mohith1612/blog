---
title: "The Invariants I Didn't Hold"
description: "An honest accounting of a write-ahead log: what it guarantees, where the documentation outran the code, and the pattern in every gap."
date: 2026-08-07
tags: ["backend", "go", "reliability", "engineering"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 10
---

Nine posts on a durability primitive. This one is the list of things it doesn't quite do.

## What it honestly is

A single-node write-ahead log with a well-specified binary format, working corruption detection, group commit that scales cleanly, prefix-consistent recovery, and a set of durability edges that are not closed.

It is **not** a system I'd put under a database that mattered. Not because the design is wrong, but because the last five percent of a durability guarantee is the entire point of a durability guarantee, and that five percent is what's below.

## The list

### Identity

**The returned LSN can disagree with the recovered LSN.** The counter increments before the enqueue, so concurrent callers can be written in the opposite order to their numbers. Because the LSN isn't stored, recovery renumbers by position and their identities swap. Post 3.

**Failed appends consume LSNs that never reach disk.** Recovery closes the gaps, so a successful caller's LSN can shift.

**Duplicate LSNs cannot be detected.** There's nothing stored to compare against.

### Durability

**Rotation fsyncs the wrong file.** A batch that crosses the segment threshold is acknowledged after syncing the new empty segment. The old segment is synced inside `Rotate`, where a failure is logged and discarded. Post 6.

**Directories are never fsynced.** Both for new segment files and for the checkpoint rename. A `rename(2)` is atomic for visibility and not durable until the directory is flushed. Posts 6 and 8.

**`Close` swallows durability errors.** A failing final fsync logs at Warn and `Close` returns `nil`:

```go
if err := active.Sync(); err != nil {
    e.logger.Warn("engine: final sync failed", zap.Error(err))
}
...
return nil
```

The one moment a caller most needs to know their data didn't make it, and the function reports success.

**A partial write poisons everything behind it.** A short write leaves an invalid record at the tail. The caller gets an error, and the segment stays active. Later appends succeed behind that bad boundary, and recovery stops at the partial record and never reaches them. Those writes are acknowledged and permanently unreachable. The segment should be sealed or truncated to the last good offset instead.

### Semantics

**Cancellation returns an error and writes the record anyway.** Once queued, a context expiry stops the caller waiting without stopping the write. Post 5.

**Checkpoint plus DELETE resurrects keys.** Merging two final-state maps cannot represent an absence. Post 8.

**Checkpoint-assisted recovery skips nothing.** `replayAfterCheckpoint` discards its parameter and does a full replay. Post 8.

### Dead code

**MANIFEST is implemented and never used.** `LoadManifest` and `SaveManifest` have no callers outside tests. The README lists it as a feature. `Engine.Close`'s own doc comment says it "persists the MANIFEST". It never calls it.

**`MemoryLimits` is declarative.** `MaxReplayBytes` exists in the config and nothing enforces it, so recovery has no memory bound.

### Testing

**Nothing crashes a process.** The crash recovery tests keep the process alive and open a second reader, which passes identically with fsync removed. Post 9.

## Three places the docs outran the code

This is the category that bothers me most, because it's the one that misleads people rather than just failing them.

The README lists MANIFEST as a shipped feature. `Close`'s doc comment describes behaviour the function doesn't have. The performance report explains a real 2.55x speedup with a mechanism that isn't implemented.

None of those were dishonest when written. Each described the design at the moment I wrote it down, and then the implementation went a different way and the prose stayed. Doc comments in particular are dangerous here, because they sit next to the code and inherit its credibility while nothing checks them.

The fix I'd actually adopt: **write doc comments in the past tense of what the function does, never the design's intent.** If I'd written "closes all segments" instead of "closes all segments and persists the MANIFEST", there'd be nothing to be wrong about.

## What held up

**The FS interface.** The best decision in the project. Every fault injection capability, the in-memory tests, the chaos injector, all of it exists because the engine never touches `os` directly. One interface, six methods, and it made the entire testing apparatus possible.

**The record framing.** Magic, bounded length, CRC32C over the metadata and payload, validated in an order where each check makes the next safe. It correctly detects every corruption I could inject, and a partial record has never reached `applyRecord`.

**Group commit.** 255 ops/s to 9,803 with no weakening of the guarantee, latency flat from 1 writer to 100, allocations flat under load.

**Prefix-consistent recovery.** You get a valid prefix of history or an error. Never a subset with a hole in it.

**Immutable segments.** Append-only, readonly once rotated. Removes whole categories of concurrency problem rather than solving them.

**`limitations.md`.** I wrote an honest limitations doc early, and rereading it while writing this series, most of it holds up. The things it names are real and correctly described. It just doesn't contain the bugs, because I didn't know about them.

## What I'd do differently

**Put the LSN in the header.** Eight bytes. Buys real identity, detectable duplicates, and verifiable ordering. I optimised for the wrong resource.

**Hold the segment reference you wrote to.** The rotation bug is entirely `ActiveSegment()` being called twice with something in between that changes the answer.

**fsync directories.** Two lines, two places, and I didn't know it was required until I went looking for why atomic rename wasn't enough.

**Write the crash harness first.** Before the format, before the engine. It's the only test that exercises the product, and building it first would have forced everything else to be shaped for it.

**Never let a performance report explain a number.** Report the measurement. If you want a mechanism, run the experiment that isolates it. My 2.55x had two candidate explanations and the benchmark couldn't distinguish them.

## The pattern, again

Same as the last two series I wrote, and by now I think it's the actual lesson rather than a coincidence.

Almost nothing here is a bug inside a component. The encoder is correct. The CRC is correct. The buffer is correct. Recovery is correct. Each one reviewed cleanly and each one has tests that pass.

Every single failure is at a **seam**:

- Between the counter and the queue, where the LSN is assigned
- Between the write and the rotation, where the fsync target changes
- Between the caller's context and the writer's queue, where cancellation stops meaning anything
- Between the checkpoint map and the delta map, where deletion can't be expressed
- Between the file and the directory, where atomicity stops implying durability
- Between the documentation and the code, where intent outlived implementation

Every one needed two things to be true at once. Features get built one at a time and tested one at a time, so the overlaps are the one place nobody is looking.

I don't have a process fix for that beyond the obvious: when two mechanisms touch, write the test that exercises both. Rotation *and* sync failure. Checkpoint *and* delete. It's a small number of extra tests and it's where all six of these were hiding.

## Closing

The thing I actually got out of this wasn't a working WAL. It was learning to state precisely where a guarantee stops.

At the start I'd have said this engine guarantees that acknowledged writes survive a crash. That sentence is close to true and the gap between "close to true" and "true" is nine posts long. Being able to draw the line exactly, to say *this holds, and this holds only if you don't rotate on that batch, and this doesn't hold at all after a power cut*, turned out to be worth more than moving it.

A durability primitive is a promise. Most of the engineering is making sure the promise isn't wider than the code.

Code is here:
👉 https://github.com/Mohith1612/wal

Thanks for reading the series.
