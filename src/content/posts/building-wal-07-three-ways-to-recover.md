---
title: "Three Ways to Recover, and What a Torn Tail Costs"
description: "Recovery isn't about salvaging as much as possible. It's about knowing exactly where you stopped believing the file."
date: 2026-07-28
tags: ["backend", "go", "databases", "reliability"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 7
---

Six posts on writing. This is the one where it pays off or it doesn't.

The process died. It comes back. Everything the engine promised has to be delivered now, from a directory of files, with no help from memory.

## The loop

Recovery is less code than you'd expect:

```go
segments, err := r.discoverSegments()

for _, info := range segments {
    if err := ctx.Err(); err != nil {
        return result, err
    }
    if err := r.replaySegment(ctx, info, mode, result); err != nil {
        return result, err
    }
}
```

Discovery is a directory scan. Parse every filename, discard anything that doesn't match the pattern, sort by segment id.

Note what's *not* consulted: there's a MANIFEST file format in the codebase and recovery doesn't read it. Segments on disk are authoritative. That's deliberate and correct, because a metadata file that disagrees with reality is worse than no metadata file. It's also more literal than intended, and post 10 covers why.

Applying a record is a four-line switch:

```go
func applyRecord(state map[string][]byte, rec *segment.Record) {
    switch rec.Type {
    case types.RecordTypePUT, types.RecordTypeCHECKPOINT:
        val := make([]byte, len(rec.Value))
        copy(val, rec.Value)
        state[string(rec.Key)] = val
    case types.RecordTypeDELETE:
        delete(state, string(rec.Key))
    case types.RecordTypeNOOP:
    }
}
```

The copy matters. Without it the state map holds slices backed by the decode buffer, and the next read overwrites them. It's the kind of aliasing bug that produces state which is corrupt in a way that looks like random data rather than like a bug.

## The real question

Everything above is bookkeeping. The actual design question is one line long:

**What do you do when a record doesn't decode?**

There isn't a single right answer, so there are three modes.

**Strict.** Stop everything, return what you have plus an error. For a system that must not operate on partial state. Loud, and correct when correctness beats availability.

**Best-effort.** Stop this segment, continue with the next. For "give me as much as you can, I'll cope." Available, and quietly lossy.

**Verify-only.** Decode and checksum everything, build no state at all. This is a health check, and it's the only mode that doesn't pay the memory cost of the state map. Running it periodically tells you about bit rot before you need the data.

```go
switch mode {
case ReplayStrict:
    return fmt.Errorf("recovery: corruption in %s at offset %d: %w", info.name, offset, err)
case ReplayBestEffort, ReplayVerifyOnly:
    // Cannot reliably find next record boundary after corruption; stop this segment.
    return nil
}
```

Three modes because there are genuinely three different callers, and picking one for everybody would have been the wrong call.

## The property that matters

Whichever mode you pick, one thing holds: **you get a valid prefix of history.**

Not a subset. A prefix. Every record up to some point, applied in order, and nothing after it.

That's what makes recovery meaningful. A prefix corresponds to a real moment in time, one the system genuinely passed through. A subset with a hole in the middle corresponds to nothing, and applying it gives you state the system was never in.

It's guaranteed by decoding completely before applying anything. Magic, version, length bounds, availability, CRC, and only then does `applyRecord` see it. A torn tail fails one of those checks and recovery stops there.

> Recovery isn't about salvaging as much as possible. It's about knowing exactly where you stopped believing the file, and never applying anything past it.

## What best-effort actually costs

That comment in the switch is doing more work than its length suggests.

Corruption in the middle of a segment means best-effort abandons **the entire rest of that segment**. Not the bad record. Everything after it.

A 256MB segment with a flipped bit near the front loses almost all of its contents, even though the records after the damage are perfectly intact.

The reason is that you don't know where the next record starts. Records are variable length, so you find record N+1 by trusting record N's length field, and record N is exactly what you can't trust.

And the format already contains the fix. From post 2, the magic number `0xDEADBA1F` is a resynchronisation marker. You could scan forward byte by byte, find the next occurrence, and try decoding there.

It isn't implemented, and the tradeoff is real: those four bytes can appear inside a payload by coincidence. You'd decode garbage that happens to pass a length check, and then you'd need the CRC to reject it, and you're relying on a 32-bit checksum to filter false positives at a rate you'd have to actually think about. Doing it properly means being able to distinguish "resynchronised correctly" from "found a coincidence", and that's more design than a one-line comment implies.

Stopping is the conservative choice. The cost isn't written down anywhere a user would see it.

## The type switch has no default

Look at `applyRecord` again. PUT, CHECKPOINT, DELETE, NOOP, and no `default` case.

A record with an unknown type byte and a valid CRC is accepted by the decoder, counted as replayed, advances the LSN, and does nothing.

That's forward compatibility. A future version could add a record type and old readers would skip it safely instead of refusing to start. It's a reasonable design and I'd probably choose it.

It happened by omission rather than by decision. There's no comment, no test for it, and nothing in the docs saying unknown types are ignored. It behaves well for a property nobody wrote down, which means the next person to add a `default: return ErrUnknownType` would be fixing what looks like a gap and would silently remove a guarantee.

## Startup pays for all of this

One consequence I underestimated.

`NewEngine` needs to know the highest LSN ever written, otherwise a restart begins allocating from 1 and reuses numbers. That was a real bug, found and fixed early. Here's the fix:

```go
func loadLastLSN(dir string, fs storage.FS, logger *zap.Logger) LSN {
    rec := recovery.New(dir, fs, logger)
    result, err := rec.Recover(context.Background(), recovery.ReplayBestEffort)
    if err != nil || result == nil {
        return 0
    }
    return LSN(result.LastLSN)
}
```

It runs a full recovery. On every open. Just to find one number.

Which means **startup time is proportional to the total uncompacted log**, and the engine builds the entire state map during startup and throws it away. `ReplayVerifyOnly` would have got the same LSN without allocating the map, and it isn't used here.

There's a second problem stacked on that. It uses `ReplayBestEffort`, so corruption makes it stop early and under-report the true high-water mark. Which reintroduces exactly the LSN reuse the function exists to prevent, in precisely the situation where you most want it to work.

The real fix is to persist `lastLSN` in the MANIFEST on clean shutdown and only fall back to scanning when the shutdown wasn't clean. That's noted in the limitations doc as future work.

## Closing thoughts

Recovery is where you find out whether the last six posts were true. The parts I'd defend are the prefix guarantee, decoding completely before applying, and offering three modes instead of guessing which one everybody wants.

The parts I wouldn't are the ones where a decision got made by not making it. Unknown types work well by accident. Mid-segment corruption discards more than it needs to, using a mechanism the format already provides. And startup does the most expensive operation in the system to retrieve a single integer that could have been written down.

In the next post: checkpoints, which are supposed to bound all of that, and the two things the benchmark showing a 2.55x speedup was not measuring.
