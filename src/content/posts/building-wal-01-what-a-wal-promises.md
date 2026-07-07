---
title: "What a Write-Ahead Log Actually Promises"
description: "The durability primitive underneath every database, and the one number that shapes every decision in it."
date: 2026-07-07
tags: ["backend", "go", "databases", "distributed-systems"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 1
---

Every database has the same problem and solves it the same way.

You accept a write. You tell the caller it succeeded. Then the machine loses power. When it comes back, is the write there?

If the answer is "sometimes", you don't have a database. You have a cache with good intentions.

## Why you can't just write the data

The obvious approach is to update the real data structure and fsync it before acknowledging.

That fails for two reasons, and they compound.

The real structure is a B-tree, or a hash index, or something with pages scattered across the disk. Updating it is random I/O, which is the slowest thing a disk does. And a single logical update usually touches several pages, so a crash halfway through leaves the structure itself corrupt, not just incomplete.

You can't make multi-page random writes atomic. So you stop trying.

## Write the intention first

Instead, before touching the real structure, you append a description of what you're about to do to the end of a file. Sequential write, one fsync, then acknowledge.

The actual data structure gets updated afterwards, lazily, in memory, whenever. If the machine dies before that happens, you replay the log on startup and redo the work.

That's the entire idea. Everything else is consequences.

Three things fall out of it:

**Crash consistency.** No acknowledged write is ever lost, because acknowledgement happens after the log entry is durable, not before.

**Ordered replay.** Mutations are re-applied in exactly the order they were written. The log is the ordering.

**Bounded replay.** Periodic checkpoints mean startup doesn't have to replay everything since the beginning of time.

## What this is not

I want to be clear about the scope, because it took me a while to hold it properly.

This is not a database. There is no `Get(key)`. There is no `Scan`. There is no query anything. The engine is write-only, and the only way to read state is to run recovery and get back a map.

It is the durability layer that a database plugs into. You bring the data structure and the query logic. It brings the guarantee that your mutations survive.

The whole public API is one method:

```go
lsn, err := engine.Append(ctx, wal.RecordTypePUT, []byte("key"), []byte("value"))
```

Four record types: PUT, DELETE, CHECKPOINT, NOOP. That's the vocabulary.

## The number everything revolves around

Here's the measurement that shaped every decision in the rest of this series.

On the machine I benchmarked on, an AMD Ryzen 5 5625U with an NVMe SSD, a single fsync takes about **3.8 milliseconds**.

That gives you 255 writes per second if you fsync on every one.

Two hundred and fifty five. On NVMe. That's not a slow disk, and it isn't a bad implementation. It's what a durability barrier costs.

fsync isn't CPU work you can optimise. It's a request to the hardware to confirm that data has left every volatile buffer it was sitting in, and it takes as long as it takes.

> A WAL doesn't make writes fast. It makes them sequential, which is the only kind of slow you can amortise.

Sequential is what makes the amortisation possible. If ten callers are waiting, you can write all ten records and fsync once, and each of them pays 0.38ms instead of 3.8ms. That's group commit, and it's post 4.

## Three ways to be durable

Because 255 ops/s isn't acceptable for everything, the engine has three modes:

| Mode | Behaviour | What you lose on power failure |
|---|---|---|
| Sync | fsync per write | Nothing acknowledged |
| Batch | fsync per batch | Nothing acknowledged |
| Async | no fsync at all | Up to ~30s of acknowledged writes |

Async is there because sometimes you genuinely don't care, and pretending otherwise just makes people work around you. It's also the mode where the word "acknowledged" stops meaning anything, since `write(2)` returning only tells you the kernel has the data in its page cache. Linux flushes dirty pages on a timer that defaults to 30 seconds.

Naming that honestly in the docs mattered more to me than the feature.

## What the rest of this series covers

Ten posts, roughly in the order the problems appear:

The binary format, and how you tell where one record ends and the next begins. The identifier that turned out not to be stored anywhere. Group commit and that 3.8ms wall. Backpressure. Segments and rotation. Recovery, and what to do when a record is corrupt. Checkpoints. Testing something whose entire job is surviving a crash.

And then the last one, which is the list of guarantees this thing doesn't quite make. There are more of those than I expected when I started writing, including two I only found while writing these posts.

In the next post: the twenty-two bytes in front of every record, and why almost all of them exist to answer the question "should I believe the next four bytes."
