---
title: "Twenty-Two Bytes in Front of Every Record"
description: "A length prefix tells you where a record ends. A checksum tells you whether to believe the length prefix."
date: 2026-07-10
tags: ["backend", "go", "binary-formats", "databases"]
series:
  name: "What It Takes to Build a Write-Ahead Log"
  order: 2
---

The last post established what a WAL promises. This one is about the smallest unit that has to keep those promises.

You append records to the end of a file. Later, possibly after a crash, you read them back. That raises two questions the file has to answer by itself:

Where does one record end and the next begin?

And is this record intact, or did the machine die halfway through writing it?

## The header

Twenty-two bytes, big-endian, in front of every payload:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | Magic `0xDEADBA1F` |
| 4 | 1 | Version |
| 5 | 1 | Record type |
| 6 | 4 | Payload length |
| 10 | 4 | CRC32C |
| 14 | 8 | Timestamp (unix nanos) |

Then `length` bytes of payload, which is the key and value.

Every one of those fields is answering a specific failure.

## The magic number

Four bytes with a fixed value at the start of every record.

It looks like decoration and it's the most important field in the header, because it's the only one that can tell you **you are not at a record boundary at all**.

Every other check assumes you're positioned correctly. If you've drifted, the version byte is garbage, the length is garbage, and the length is the dangerous one. The magic is a cheap assertion that the assumption still holds:

```go
magic := binary.BigEndian.Uint32(data[MagicOffset:])
if magic != types.Magic {
    return nil, 0, types.ErrMagicMismatch
}
```

It's also, in principle, a resynchronisation marker. If you hit corruption mid-file you could scan forward for the next magic and resume from there. That capability is what the sentinel buys you. This engine doesn't use it, and post 7 is about what that costs.

## Never trust the length prefix

This is the bit I'd tell anyone writing a binary format.

The length field is four bytes read straight off disk. If those bytes are corrupt, they can say anything. Four billion, say. And the obvious next line of code is:

```go
payload := make([]byte, payloadLen)   // please don't
```

A single flipped bit and you've asked for a 4GB allocation and taken down the process. Corruption in a data file should not be a denial of service.

So the length gets bounds-checked before it is used for anything:

```go
if payloadLen > MaxPayloadSize {
    return nil, 0, types.ErrInvalidLength
}

total := HeaderSize + int(payloadLen)
if len(data) < total {
    return nil, 0, types.ErrTruncatedRecord
}
```

Sanity first, then availability, then finally the CRC. The order matters, because each check makes the next one safe to perform.

> A length prefix tells you where the record ends. A checksum tells you whether to believe the length prefix. You have to validate in the order that keeps you alive.

## CRC32C, not a hash

The checksum is CRC32C, the Castagnoli polynomial.

That's a deliberate choice and it's worth being precise about why, because "use a real hash" is common advice that's wrong here.

The threat model is accidental corruption. Bit rot, a torn write, a cable that flipped a bit, a disk that returned the wrong sector. It is **not** an attacker who can rewrite your log file, because an attacker who can do that can also recompute a SHA-256 and you've gained nothing.

Against accidents, CRC32 is excellent. It's designed to catch exactly the burst errors that storage produces, and it has hardware support on every modern x86 and ARM chip, which makes it roughly free. SHA-256 would cost meaningfully more CPU per record to defend against a threat this format cannot defend against anyway.

Verified against a known test vector rather than against itself, which matters. A checksum implementation that's self-consistently wrong passes every round-trip test you write.

## What the checksum covers

Encoding, with one detail worth noticing:

```go
var crcInput []byte
crcInput = append(crcInput, types.CurrentVersion)
crcInput = append(crcInput, byte(r.Type))
crcInput = binary.BigEndian.AppendUint32(crcInput, payloadLen)
crcInput = binary.BigEndian.AppendUint64(crcInput, uint64(r.Timestamp.UnixNano()))
crcInput = append(crcInput, payload...)

crc := checksum.Compute(crcInput)
```

The CRC covers the version, type, length, timestamp and payload. It does **not** cover the magic.

That's fine, and it's fine for a specific reason: the magic is a constant, checked by equality before the CRC is ever computed. Including a constant in a checksum adds nothing. Corruption in those four bytes is caught by the comparison, not by the CRC.

Covering the length is the part that matters. A checksum over only the payload would let a corrupt length slip through, and a corrupt length is how you desynchronise the entire rest of the file.

## The torn tail

Here's the case this whole design exists for.

The process is writing a record. It gets 30 bytes in. The machine loses power.

The file now ends with a partial record. On restart the reader gets to that offset and one of three things happens:

- Not enough bytes for a header, so `ErrUnexpectedEOF`
- Header is there but the payload is short, so `ErrTruncatedRecord`
- Everything is there but a byte was mangled, so `ErrChecksumMismatch`

All three are detected. None of them reach `applyRecord`. The state you rebuild contains every complete record before that point and nothing after.

That's the property the whole engine rests on: **a partial record is never applied**. Not "usually", not "mostly". The decode has to succeed completely before anything touches state.

## Version, for later

One byte, checked with a deliberate asymmetry:

```go
version := data[VersionOffset]
if version > types.CurrentVersion {
    return nil, 0, types.ErrVersionMismatch
}
```

Greater than, not equal to. A newer version is rejected, because you cannot safely parse a format you don't know. An older version is accepted, because you're expected to still handle what you used to write.

It's one byte spent on the assumption that the format will change. It always does.

## Closing thoughts

Twenty-two bytes, and almost all of them are about doubt. Am I in the right place. Do I understand this format. Is this length plausible. Is this data intact.

The payload is the only part that's actually about the record. Everything else is the file defending itself against a reader that might be wrong about where it is.

In the next post: the one field you'd absolutely expect to find in that header, which isn't there, and the three problems that follow from its absence.
