---
title: "The Sequence Number That Was Never Written Down"
description: "The LSN is the identity of every record in the log. It isn't stored on disk, and three problems follow from that."
date: 2026-07-14
tags: ["backend", "go", "databases", "concurrency"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 3
---

Go back to the twenty-two byte header from the last post.

Magic, version, type, length, CRC, timestamp. Six fields.

There's an obvious one missing. Every record in a write-ahead log has a Log Sequence Number, the monotonically increasing identifier that defines replay order and that `Append` hands back to the caller. It is arguably the most important property a record has.

It is not in the header.

## Where the LSN actually comes from

The decoder takes it as a parameter:

```go
func DecodeRecord(data []byte, lsn types.LSN) (*Record, int, error)
```

It's passed in, not read out. The caller of the decoder is expected to already know.

And it knows because of the filename. Segments are named like this:

```
wal-000001-0000000000000000001.log
     ^id    ^startLSN
```

The reader parses the starting LSN out of the name, hands it to the first record, and then counts:

```go
rec, consumed, err := DecodeRecord(full, r.nextLSN)
...
r.nextLSN++
```

So a record's identity is **its filename plus its position in the file**. Nothing more.

## Why that's genuinely appealing

I want to give the design its due, because the reasoning is sound.

It saves 8 bytes per record, which on small records is a real percentage. More importantly, the LSN is *redundant* with position. If records are written in order, the Nth record in a segment starting at LSN 100 is LSN 100+N by definition. Storing it is storing a fact the file already knows.

It's also self-correcting in a nice way. There's no possibility of the stored LSN disagreeing with the physical order, because there's no stored LSN to disagree.

The catch is that all of this rests on one assumption: **that physical order matches the order LSNs were assigned**.

## The assumption doesn't hold

Here's `Append`:

```go
// Assign LSN atomically before enqueuing. Callers know their LSN immediately.
lsn := LSN(e.lsn.Add(1))

req := &buffer.WriteRequest{
    Type:  uint8(typ),
    Key:   key,
    Value: value,
    LSN:   uint64(lsn),
}

if err := e.buf.Submit(ctx, req); err != nil {
    return 0, err
}
return lsn, nil
```

The counter increment and the enqueue are two separate operations. Each is individually atomic. Together they are not.

Two goroutines:

```
Goroutine A                 Goroutine B
───────────                 ───────────
lsn.Add(1) -> 1
                            lsn.Add(1) -> 2
                            Submit(req B)     <- B reaches the queue first
Submit(req A)
```

The writer drains the queue in arrival order. The file now contains B's record, then A's.

On recovery, the reader assigns by position. B's record gets LSN 1. A's record gets LSN 2.

But `Append` returned 1 to A and 2 to B.

Their identities have been swapped, silently, with no error anywhere and no way to detect it after the fact. A holds a receipt saying LSN 1, and LSN 1 is B's data.

## Two more consequences

**Failed appends consume LSNs that never reach disk.**

If `Submit` returns an error, that LSN is gone from the in-memory counter and no record was ever written. On recovery, positions are numbered contiguously, so the gap closes up.

Which means the LSN a successful caller was handed can be *higher* than the LSN recovery assigns to their record. Not swapped this time, just shifted. Every failure before yours shifts you down by one.

For a value whose entire purpose is stable identity, that's a problem. You cannot hand an LSN to a caller, have them store it as a reference, and expect it to still point at their record after a restart.

**Duplicate LSNs cannot be detected.**

Not "are prevented". Cannot be detected. There is no stored LSN to compare against, so no consistency check on this is even expressible. The reconstruction is unfalsifiable, which means it's also unverifiable.

## The test that hides it

There are concurrency tests for exactly this, and they pass.

They spawn many goroutines, collect every returned LSN, sort them, and assert uniqueness and no gaps.

Sorting is the problem. Sorting throws away order, and order is the entire thing that's broken. A set of unique contiguous integers is exactly what you get whether the physical layout matches or not.

What the test would need to do is read the records back and assert that the record at reconstructed LSN N contains the key that `Append` returned N for. That's the assertion that fails. It isn't written.

This is the most useful thing I took from the whole project. **The test was measuring the property that was easy to measure, not the property that mattered.** It gave real confidence in a guarantee that doesn't exist, which is worse than no test, because no test at least leaves you suspicious.

> If the identity you hand out isn't the identity you store, you don't have an identifier. You have a receipt number, and the receipt is only valid until the next restart.

## What the fixes are

Two options, and they're a genuine tradeoff rather than one obviously right answer.

**Store it.** Eight more bytes in the header, covered by the CRC. Recovery reads the LSN instead of counting, and can then verify that the sequence is contiguous and matches expectation. Costs 8 bytes per record and makes the format bigger. Buys real identity, plus the ability to detect duplicates and gaps.

**Assign it inside the writer.** Move the counter increment into the single writer goroutine, where it's already serialised with the physical order by construction. Costs the ability to return the LSN immediately, since the caller now has to wait for the write to be scheduled. That is a real API downgrade, and the comment in the code says it out loud: *callers know their LSN immediately.*

The current code has the API benefit and quietly loses the guarantee that made the LSN worth returning.

I'd take the eight bytes.

## Closing thoughts

This is the sharpest thing in the codebase, and I found it by writing about it rather than by running anything.

The design is coherent, the reasoning behind it is good, and it holds perfectly for a single writer. It stops holding the moment two goroutines call `Append` concurrently, which is the case the engine is explicitly built for.

That's a pattern I keep hitting. Not a wrong decision, but a decision made under an assumption that later stopped being true, with nothing in the tests positioned to notice.

In the next post: the 3.8 millisecond fsync wall from post one, and how you get from 255 writes a second to nearly ten thousand without lying about durability.
