---
title: "Testing a Thing Whose Whole Job Is Surviving a Crash"
description: "You can't unit test a power cut. What I built instead, and the gap I left in the middle of it."
date: 2026-08-04
tags: ["backend", "go", "testing", "reliability"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 9
---

Eight posts of claims about durability. This is the one about whether any of them were verified.

The problem is stated in one sentence: you cannot unit test a power cut.

## Everything follows from one interface

The single best decision in this project was refusing to let the engine touch `os` directly.

```go
type FS interface {
    OpenFile(name string, flag int, perm os.FileMode) (File, error)
    Remove(name string) error
    Rename(oldpath, newpath string) error
    MkdirAll(path string, perm os.FileMode) error
    ReadDir(name string) ([]os.DirEntry, error)
    Stat(name string) (os.FileInfo, error)
}
```

Every file operation in the engine goes through that. `OSFS` is the real one and it's a thin passthrough.

Once that boundary exists, everything testable becomes possible, and none of it needs mocking frameworks or build tags. Two implementations do the work.

## FakeFS and FaultyFS

`FakeFS` is an in-memory filesystem. Tests get a real directory tree with no disk, no temp directory cleanup, no cross-test interference, and they run in microseconds. It also tracks whether `Sync` was called, so a test can assert that the engine fsynced when the durability mode says it should.

`FaultyFS` wraps any FS and breaks it on demand:

```go
type FaultyFS struct {
    Inner FS

    FailAfterWrites int32   // Write fails after N calls
    CorruptAfterN   int32   // flip a byte in the output after N writes
    FailSync        bool    // every Sync returns an error
    ShortWriteAt    int32   // truncate this write to 1 byte
    DiskFullAfter   int64   // ENOSPC after N bytes
}
```

That short list is close to the complete taxonomy of how storage betrays you. Writes that fail. Writes that lie about how much they wrote. Syncs that fail. Data that changes underneath you. Disks that fill.

All of it deterministic, all of it configured with a struct field. No sleeps, no flakiness, no "run it a few times and see."

On top of that, a chaos injector that works on segment files directly, with `TruncateSegment` for torn tails and `CorruptByte` for bit rot. That's how the recovery paths from post 7 get exercised: truncate a segment mid-record, reopen, assert the recovered prefix.

## The rest of the suite

Round trips for every record type. Magic, checksum, truncation and version corruption. A known CRC32C test vector, which matters more than it sounds, because a checksum implementation that's self-consistently wrong passes every round trip you write. Fuzz seeds on the decoder. Segment filename parsing and lifecycle transitions. All three replay modes. Idempotent replay, asserting that recovering twice gives the same state. Backpressure and submit timeout. Goroutine leak checks. Randomized malformed input asserting the recoverer never panics, which is a weak assertion that catches a real class of bug.

`go test ./internal/... -count=1` passes clean.

It's a good suite. I'd point at it as an example of testing a systems component properly.

## And it never crashes anything

Here's the gap.

The tests named for crash recovery keep the process alive. They write records, then open a second reader against the same directory, and assert the data reads back.

That verifies the file on disk is well-formed and the decoder works. It does not verify the thing a WAL exists for.

A process that's still running has its page cache. Every byte it wrote is readable whether or not it ever reached the disk, because the reads are served from the same kernel cache the writes went into. **A test like this passes identically with fsync removed entirely.**

Which means the central claim of the entire engine, that an acknowledged write survives the machine dying, is not covered by any test in the repository. The durability mode is the one variable the suite cannot observe.

> Every test in this suite proves the code does what I wrote. None of them prove the disk did what I assumed.

## The mock has the same blind spot

`FakeFS` tracks `Sync()` calls, so a test can assert the engine called it.

But `FakeFS` is a map in memory. Its `Sync` is a counter increment. It doesn't model drive write caches, doesn't model directory entry persistence, doesn't model filesystem write reordering.

So "we called Sync" is all you can ever assert. Whether calling Sync would have made the data survive is outside what the model can represent.

That's exactly where the two bugs in this series hid. Post 6's rotation fsyncs the wrong file, and a mock that counts Sync calls sees a Sync call. Post 8's missing directory fsync is invisible to a model with no concept of directory durability.

A mock encodes your assumptions about the thing it replaces. It can't fail in a way you didn't think of.

## What's actually missing

Being specific, because "test it properly" isn't advice.

**A subprocess kill harness.** A child process appends records and reports the LSNs it got acknowledgements for. The parent SIGKILLs it at a random point, reopens the directory, recovers, and asserts every acknowledged LSN is present. Run it a few thousand times with the kill point varied. There's a `chaos_loop.sh` in the repo that gestures at this and no harness behind it.

That catches the rotation bug. An acknowledged write whose fsync went to the wrong file disappears when the process is killed rather than closed.

**Real power loss, or a simulation of it.** `dm-flakey` on Linux can drop writes that weren't fsynced. A VM you can hard-power-off is cruder and closer to the real thing. This is what separates "we called fsync" from "the data is on the platter", and it's the only way to catch the directory fsync gap.

**Stronger assertions on the randomized tests.** They currently assert bounds like "recovered records <= written records". True, and satisfied by recovering nothing. The real property is that recovered state equals the valid prefix, which requires the test to know where the prefix ends, which the injector does know because it chose the truncation point.

**A model-based test.** Keep a reference sequence of operations, apply the same operations to the engine under injected failures, and assert recovered state matches replaying the reference up to the last acknowledged operation. That's the assertion that would have caught the checkpoint delete bug from post 8, because it doesn't care which code path produced the state.

## The uncomfortable summary

The suite tests the code thoroughly and tests the guarantee not at all.

Everything above the storage boundary is well covered, and the boundary is where all the risk lives. I built an excellent apparatus for injecting storage faults and then never used it to answer the one question the project exists to answer.

I don't think the tests are worthless. Most bugs in a codebase like this are ordinary bugs, and this suite catches those. It's more that I had accurate confidence about the wrong region, and the coverage number said nothing about which region it was.

## Closing thoughts

If I started again, the subprocess kill harness would be the first test written, before the record format. Not because it's the most likely to fail, but because it's the only one that tests the actual product, and building it first would have forced the engine to be testable that way from the beginning.

Instead it's the one thing a `chaos_loop.sh` implies exists and doesn't.

One post left: the full list of guarantees this engine makes slightly more loudly than it delivers, including the two I found while writing these posts.
