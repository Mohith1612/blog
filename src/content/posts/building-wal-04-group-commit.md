---
title: "Group Commit, or Refusing to Pay for fsync Alone"
description: "Getting from 255 writes a second to nearly ten thousand, without weakening a single durability guarantee."
date: 2026-07-17
tags: ["backend", "go", "performance", "concurrency"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 4
---

Post one ended on a number. On an NVMe SSD, one fsync takes about 3.8 milliseconds, which caps a sync-per-write log at 255 writes per second.

This post is about getting to 9,803 without weakening the guarantee.

## fsync is not work you can optimise

The instinct with a slow operation is to make it faster. That doesn't apply here.

fsync isn't CPU. It isn't an algorithm. It's a request to the storage stack to confirm that data has left every volatile buffer between you and the physical medium, and it returns when that's true. There's no clever implementation that makes stable storage acknowledge sooner, because the acknowledgement is the entire product.

So you can't reduce the cost. What you can do is notice who's paying it.

The key property: **fsync cost is per call, not per byte**. Flushing one record and flushing a thousand cost roughly the same, because the expensive part is the barrier, not the transfer.

Which means if a thousand writers are each waiting on their own fsync, they're each paying full price for something they could have shared.

> fsync costs the same whether you're flushing one record or a thousand. Group commit is just refusing to pay it alone.

## One writer, everybody else waits

The architecture is a bounded channel and a single goroutine.

Callers don't write. They submit a request and block on a channel that belongs to them:

```go
type Buffer struct {
    cfg        Config
    queue      chan *WriteRequest
    flusher    Flusher
    stopCh     chan struct{}
    doneCh     chan struct{}
    lsn        *atomic.Uint64
    queueDepth atomic.Int64
}
```

The writer goroutine drains whatever has accumulated, encodes it all into one contiguous buffer, does one `Write`, does one `Sync`, and then closes every waiter's `Done` channel.

```go
var encoded []byte
for _, req := range batch.Requests {
    rec := &segment.Record{
        LSN:       LSN(req.LSN),
        Type:      RecordType(req.Type),
        Timestamp: now,
        Key:       req.Key,
        Value:     req.Value,
    }
    encoded = append(encoded, segment.EncodeRecord(rec)...)
}

n, err := active.Write(encoded)
```

Two things worth pointing at.

There's **no mutex on the hot write path**. Callers contend on a channel send, which Go implements far better than a lock around file I/O, and then wait on a channel that nobody else touches. The serialisation that a WAL needs anyway is provided by having exactly one writer, rather than by locking.

And the batch becomes **one** `Write` call, not N. All the records are concatenated first. That matters more than it looks: N syscalls with N context switches versus one, and on the recovery side it means a batch lands as a contiguous run.

## The measurements

Single writer, all three modes:

| Mode | Throughput | P50 | P99 |
|---|---:|---:|---:|
| sync | 255 ops/s | 3.8 ms | 7.8 ms |
| batch | 100 ops/s | 10.1 ms | 12.7 ms |
| async | 100 ops/s | 10.1 ms | 10.3 ms |

Read that again, because it's the opposite of what you'd expect.

**With one writer, batch mode is worse than sync mode.** 100 ops/s against 255.

Async, which does no fsync at all, is also 100 ops/s. The durability mode makes almost no difference.

## Why the fast mode is slower

Because with a single sequential writer there is no group.

The flusher runs on a 10ms ticker. One caller submits, and there's nothing else in the queue, so it waits for the timer. 10ms later its batch of one is written. It submits again. Waits again.

100 flushes per second, one record each, 100 ops/s. The fsync isn't the bottleneck any more. The ticker is. That's why async is the same number: removing the fsync from a path dominated by a timer changes nothing.

The lesson is that **group commit is a concurrency optimisation, not a throughput optimisation.** It does nothing for a single caller and it can actively hurt them. If your workload is one sequential writer, sync mode is both faster and safer, which is a genuinely counterintuitive thing to have to document.

## What it looks like with load

| Mode | Writers | Throughput | P50 | P99 |
|---|---:|---:|---:|---:|
| batch | 1 | 100 ops/s | 10.1 ms | 11.3 ms |
| batch | 10 | 997 ops/s | 10.1 ms | 11.3 ms |
| batch | 100 | 9,803 ops/s | 10.2 ms | 14.2 ms |
| async | 100 | 9,947 ops/s | 10.1 ms | 10.7 ms |

Ten times the writers, ten times the throughput, and **latency barely moves**. P50 stays at 10.1ms from 1 writer to 100.

That's the shape you want, and it's worth understanding why it happens. Every caller waits for the next tick regardless. Adding more callers doesn't make anyone wait longer, it just means more records ride along on the same flush.

The ceiling is arithmetic:

```
10 ms flush interval  ->  100 flushes/sec
100 writers, each waiting on a tick  ->  ~100 records per flush
100 x 100 = 10,000 ops/sec
```

The measured 9,803 is 98% of that. The remaining 2% is encoding and rotation.

Which tells you the interesting thing: the engine is no longer limited by the disk at all. It's limited by a constant in the config. Halve the flush interval and you double the ceiling while halving the batch size, and you'd trade throughput back for latency at some point. That's a tuning knob, not an engineering problem, and getting to the point where your bottleneck is a config value is most of the job.

## Allocation behaviour

From the microbenchmarks:

| Benchmark | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| AppendSync | 3,818,328 | 721 | 10 |
| ConcurrentWriters10 | 1,000,524 | 902 | 7 |
| ConcurrentWriters100 | 100,262 | 1,040 | 7 |
| ConcurrentWriters1000 | 10,303 | 1,131 | 7 |

Two things I was happy about.

ns/op drops by almost exactly 10x for each 10x of concurrency, across three orders of magnitude. That's the amortisation working exactly as designed, with no degradation from contention.

And allocations stay flat at 7 per op while bytes creep from 902 to 1,131. The engine doesn't allocate more per record under load. Whatever else is wrong with this codebase, the write path doesn't get worse when you push on it.

## What it costs

Being fair about the downsides.

**Latency floor.** Every batch caller waits up to a full flush interval even when the system is idle. 10ms minimum, which is a lot if you were expecting microseconds.

**Head of line blocking.** One writer means one slow write stalls everyone in that batch. There's no parallel pipeline.

**A hard ceiling.** One encoding goroutine is one CPU core. The engine tops out somewhere in the hundreds of thousands of ops per second in async mode regardless of how many callers there are, and no amount of concurrency gets past that.

For a WAL I think that's the right trade. Ordering is the product, and a single writer gives you ordering for free rather than through a reservation protocol. But it is a ceiling, and it's the kind that doesn't announce itself until you're already at it.

## Closing thoughts

The satisfying part of this one was that the fix wasn't clever. It was noticing that a fixed cost was being paid repeatedly by people who could have shared it.

The unsatisfying part was the measurement that showed the "fast" mode losing to the simple one under the workload most people will try first. That result is in the performance report because it should be, and it's the kind of thing benchmarks are for: not confirming that the optimisation worked, but finding out when it doesn't.

In the next post: what happens when the queue fills up, and a cancellation that returns an error while the record gets written anyway.
