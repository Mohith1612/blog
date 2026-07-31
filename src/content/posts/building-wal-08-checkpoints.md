---
title: "Checkpoints, and What the Benchmark Wasn't Measuring"
description: "A 2.55x speedup that was real, produced by a mechanism that doesn't exist, hiding a bug that resurrects deleted keys."
date: 2026-07-31
tags: ["backend", "go", "databases", "performance"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 8
---

The last post ended with startup replaying the entire log. Checkpoints are the answer to that, and they're the part of this codebase I got most wrong.

## The idea

Periodically, write out the current state as a snapshot tagged with the LSN it represents. On recovery, load the snapshot and replay only what came after.

Replay cost stops being proportional to all history and becomes proportional to history since the last checkpoint. Then compaction deletes the segments the checkpoint has superseded, and the disk stops growing forever too.

Straightforward, and the publication mechanism is genuinely the nicest code in the project.

## Publishing atomically

A checkpoint is only useful if a reader can never see a partial one. The pattern:

```
write to checkpoint.tmp
fsync the file
rename checkpoint.tmp -> checkpoint-000042.ckpt
```

`rename(2)` is atomic on POSIX. A reader looking at that directory sees either the old checkpoint or the new one, never a half-written file. The `.tmp` name is ignored by the loader, so an interrupted write leaves debris rather than damage.

There's a whole-file CRC as well, and if the newest checkpoint fails it the loader falls back to an older valid one. Two independent protections against two different failures: torn writes handled by the rename, bit rot handled by the checksum.

I'd write this the same way again.

## Except the directory is never fsynced

Same gap as post 6, and it undercuts the whole thing.

`rename` is atomic with respect to *visibility*. It is not durable until the containing directory is fsynced. The rename is a modification to the directory, and directory modifications sit in the page cache like any other write.

So after a power failure the sequence can be: the checkpoint file exists, its contents are intact and fsynced, and the rename that gave it its final name is gone.

The careful atomic publication protects against a torn checkpoint and does not protect against a lost one. Adding an fsync on the directory after the rename is a few lines and it isn't there.

## Now the part I got wrong

Here is the function that's supposed to make recovery faster:

```go
// replayAfterCheckpoint replays only WAL segments that contain records after checkpointLSN.
func replayAfterCheckpoint(ctx context.Context, dir string, fs storage.FS,
    checkpointLSN types.LSN, mode recovery.ReplayMode, logger *zap.Logger) (*recovery.RecoveryResult, error) {

    // Create a temporary directory view that only contains segments after the checkpoint.
    // We use a filtered FS approach: create a FakeFS copy with only relevant segments.
    // Simpler approach: use the existing recovery but accept it replays all segments;
    // the CHECKPOINT records in the WAL will overwrite state anyway.
    // For correctness, just do full WAL replay for now.
    // TODO: optimize to skip segments fully before checkpointLSN.
    _ = checkpointLSN
    result, err := recovery.New(dir, fs, logger).Recover(ctx, mode)
    ...
}
```

`_ = checkpointLSN`.

The parameter is explicitly discarded. The function does a full replay of every segment. The doc comment above it says it replays only segments after the checkpoint. It does not.

The optimisation is a TODO with four lines of reasoning about how it might be done.

## And the benchmark said it worked

From the committed performance report:

| Strategy | Elapsed | Speedup |
|---|---:|---:|
| Full WAL replay | 9.8 ms | 1.0x |
| Checkpoint-assisted | 3.8 ms | **2.55x** |

> Checkpoint-assisted recovery skips replaying compacted segments entirely, replaying only WAL records with LSN > checkpoint_LSN. In this workload (4 segments, last segment = active), 3 out of 4 segments are skipped, yielding a 2.55x speedup.

The 2.55x is real. I measured it, the numbers are honest, the run happened.

The explanation underneath it is wrong.

Nothing skipped any segments by comparing LSNs, because the function that would do that throws its parameter away. Recovery was faster because **compaction had already deleted those three segment files from disk**. There was less to read, so reading took less time.

Same number, completely different mechanism.

## Why the distinction is not pedantic

It changes what happens in cases the benchmark didn't cover.

Take a checkpoint without running compaction's pruning step, which is a perfectly ordinary thing to want, and you get **zero speedup**, plus the extra cost of loading and merging the checkpoint. Slower than not having one.

The report's projection also inherits the error: "a 10-segment WAL where 9 are compacted would approach 9-10x". That happens to still roughly hold, because pruning scales the same way, but it holds by luck rather than because the reasoning behind it was right.

And the benchmark structurally cannot tell the difference, because compaction writes the checkpoint and prunes the segments in one operation. There's no configuration in the test that separates them, so the two candidate explanations produce identical measurements and I picked the wrong one.

> A benchmark measures an outcome. The explanation attached to it is a hypothesis, and passing the benchmark is not evidence for the hypothesis.

## The second bug

The merge is worse than the missing optimisation.

```go
if mode != recovery.ReplayVerifyOnly {
    merged.State = state                     // state from the checkpoint
    if walResult.State != nil {
        for k, v := range walResult.State {  // deltas from the WAL
            merged.State[k] = v
        }
    }
}
```

Take the checkpoint's map, overwrite with the WAL's map. Reasonable at a glance.

Now recall from post 7 how a delete is replayed:

```go
case types.RecordTypeDELETE:
    delete(state, string(rec.Key))
```

A delete removes the key from the map. In a final-state map, a deleted key is not marked deleted. **It is absent.**

And you cannot express absence by iterating a map and assigning. The loop only ever sets keys. There is no value of `v` that removes `merged.State[k]`.

So:

```
PUT   k = v1
CHECKPOINT          (k = v1 is in the snapshot)
DELETE k            (k is absent from the delta map)
prune old segments
recover             ->  k = v1
```

The key comes back. With its old value. The delete is silently undone.

## Why it's structural

This isn't a missing line. Two final-state maps cannot be merged, ever, because one of them is trying to communicate an absence and a map has no way to say "this key is absent *on purpose*".

The fixes all require keeping the ordering information:

Keep tombstones in the delta, so a DELETE leaves an explicit marker rather than a gap, and the merge knows to remove. Or don't build a delta map at all, and replay the post-checkpoint records as an ordered sequence directly against the checkpoint state. The second is cleaner and it's what I'd do.

Both mean giving up "merge two maps" as the mental model, which was the thing that made the code look obviously correct.

Right now the bug is masked, because `replayAfterCheckpoint` does a full replay and the full replay's state is already correct. It only bites once segments have actually been pruned, so the missing optimisation is hiding the correctness bug. Implementing the TODO would expose it.

That's an uncomfortable thing to find. The half-finished feature is the only reason the finished one appears to work.

## What the tests said

Nothing, and the forensic audit of this repo lists it plainly under test limitations: **no post-checkpoint PUT/DELETE delta test.**

There are checkpoint tests. CRC validation, fallback to an older checkpoint, compaction idempotence. They all pass. None of them delete a key after taking a checkpoint.

It's the same shape as post 6's rotation bug. Checkpoints are tested. Deletes are tested. The interaction isn't.

## Closing thoughts

Atomic publication via tmp-fsync-rename is good and I'd reuse it, minus the missing directory fsync.

Everything after that is a lesson about believing your own documentation. A doc comment describing intent, a performance report explaining a real number with a mechanism that isn't implemented, and a merge that reads as obviously right while being unable to represent deletion.

The number was true. The story I told about it wasn't. I'd rather have caught that with a test than with a blog post.

In the next post: the test suite, which is genuinely extensive, and the one thing it never does despite this being a crash recovery engine.
