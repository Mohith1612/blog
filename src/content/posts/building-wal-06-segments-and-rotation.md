---
title: "Segments, and the fsync That Hit the Wrong File"
description: "Splitting the log into files makes almost everything easier. The seam between writing and rotating is where a durability bug was hiding."
date: 2026-07-24
tags: ["backend", "go", "databases", "reliability"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 6
---

So far the log has been one file that grows forever. That doesn't survive contact with reality.

You can never delete anything, because deleting the front of a file isn't an operation. Recovery has to read all of it. And a single corrupt byte anywhere is a problem for the whole log rather than for one bounded region.

So the log is split into segments.

## The filename is part of the format

```
wal-000001-0000000000000000001.log
    ^id     ^startLSN
```

Both fields are fixed width and zero padded, which is doing real work. It means lexicographic sort equals numeric sort, so a plain directory listing comes back in log order, and `ls` shows you the log in sequence.

The `startLSN` in the name isn't decoration either. From post 3: the LSN is not stored in any record, so this filename is where recovery gets its starting point. Parse the name, hand the number to the reader, count from there.

```go
_, err = fmt.Sscanf(name, "wal-%06d-%019d.log", &id, &lsn)
```

Which makes the filename part of the on-disk format. Rename a segment and you've corrupted the log without touching a byte of its contents. That's worth knowing and isn't stated anywhere in the docs.

## Lifecycle

A segment moves through six states:

```
OPEN -> ACTIVE -> ROTATING -> READONLY -> COMPACTED -> DELETED
```

The important one is READONLY. Once a segment stops being active it is never written again.

Immutability buys a lot. Recovery reads without coordinating with writers. Compaction can process a segment while the engine is running. There is no in-place update anywhere in the system, so there's no torn-update case to reason about except at the tail of the single active segment.

That's the general principle and it keeps showing up: append-only plus immutable-once-closed removes whole categories of concurrency problem rather than solving them.

## Rotation

```go
if m.active != nil {
    m.active.TransitionTo(types.SegmentStateRotating)
    if err := m.active.file.Sync(); err != nil {
        m.logger.Warn("manager: sync before rotate failed", zap.Error(err))
    }
    if err := m.active.file.Close(); err != nil {
        m.logger.Warn("manager: close old segment failed", zap.Error(err))
    }
    m.active.mu.Lock()
    m.active.state = types.SegmentStateReadonly
    m.active.mu.Unlock()
}
```

Sync the old file, close it, mark it readonly, create the new one. The sequence is right.

Note both errors are logged and swallowed. Hold that thought.

## The bug

Here's the flush path, with the parts that matter:

```go
active := e.segmgr.ActiveSegment()          // (1) the current segment

n, err := active.Write(encoded)             // (2) write the batch to it

if active.Size() >= e.cfg.MaxSegmentBytes {
    if _, err := e.segmgr.Rotate(nextLSN); err != nil {   // (3) rotate
        e.logger.Error("engine: segment rotation failed", zap.Error(err))
    }
}

switch e.cfg.SyncPolicy.Mode {
case DurabilitySync, DurabilityBatch:
    if err := e.segmgr.ActiveSegment().Sync(); err != nil {   // (4) fsync
        return fmt.Errorf("engine: fsync: %w", err)
    }
}
```

Line (1) captures the active segment in a local variable. Line (2) writes to it.

Line (4) calls `ActiveSegment()` **again**.

If rotation happened at (3), that's a different file. A brand new, empty one.

So on any batch that crosses the segment size threshold, the engine fsyncs an empty file, gets a success back, and acknowledges the write. The data it just wrote is in a different file that this code path never syncs.

## How bad is it

Less catastrophic than it first looks, and still wrong.

`Rotate` does sync the old file at (3), so on the normal path the data does get flushed. The engine gets the right outcome by a different route than the one it thinks it's taking.

The problem is what happens when that sync fails. It's logged at Warn level and execution continues. Then (4) syncs the empty new segment, which succeeds, and the batch is acknowledged.

So: **the one code path where the old segment's sync failure actually matters is the one path that discards it.** A caller in sync mode is told their write is durable when the fsync that would have made it durable returned an error nobody propagated.

The fix is small. Sync the segment you wrote to, not whatever is active now:

```go
active := e.segmgr.ActiveSegment()
n, err := active.Write(encoded)
// ...
if err := active.Sync(); err != nil {      // the one we actually wrote to
    return fmt.Errorf("engine: fsync: %w", err)
}
// rotate after the data is durable
```

And let `Rotate`'s sync error propagate rather than logging it.

## Why nothing caught it

This is the part I find most instructive.

There are rotation tests. They check that segments roll at the size threshold, that the new file is created with the right name, that the old one goes readonly. They pass.

There are sync failure tests. `FaultyFS` has a `FailSync` flag, and there are tests asserting that a failing fsync surfaces as an error to the caller. They pass.

Triggering this bug needs **both at once**: a batch that crosses the rotation threshold *and* a sync that fails. No test does both, because the rotation tests are about rotation and the sync tests are about syncing.

> Features get tested one at a time because that's how they get built. Bugs live where two of them overlap, which is the one place nobody is looking.

Every project in this series has had a version of this. It's the most reliable pattern I've found for where to look for real bugs.

## The other thing missing here

Related, and also unfixed: creating a new segment file writes a new directory entry, and that entry is not durable until the containing **directory** is fsynced. Nothing in this code fsyncs the directory.

After a power failure the segment file can exist with its data intact while the directory entry that names it is gone. The data is on the platter and unreachable, because the thing that made it findable was never flushed.

Directory fsync after create and after rename is one of those POSIX requirements that's easy to not know about, and it applies in two places in this engine. Post 8 hits the other one.

## Closing thoughts

Segments are a good design and most of this post is about the seam rather than the idea. Bounded files, immutable once closed, sortable names, a lifecycle you can assert on. Everything downstream is easier for it.

The bug is four lines apart, in a function I wrote, read, and reviewed several times. Calling `ActiveSegment()` twice reads as harmless right up until you notice that something in between can change the answer.

In the next post: reading it all back, the three different things "recover" can mean, and what one corrupt record costs you.
