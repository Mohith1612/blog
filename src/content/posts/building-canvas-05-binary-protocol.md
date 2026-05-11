---
title: "Writing a Binary WebSocket Protocol by Hand"
description: "What actually goes over the wire in a collaborative canvas, and why the ready made library didn't fit."
date: 2026-05-11
tags: ["backend", "websockets", "protocol", "crdt"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 5
---

In the last post the document became a CRDT, and the thing being sent stopped being a shape. It became a binary update.

This post is about the layer that carries it.

## Why not just use the library

Yjs has a WebSocket provider. It's called y-websocket and it does exactly this job.

I couldn't use it.

The server is uWebSockets.js, which is not the Node `ws` module. It doesn't expose an EventEmitter, the handlers are callbacks on a behaviour object, and the message you receive is a raw ArrayBuffer that gets reused. y-websocket assumes the `ws` API fairly deeply.

So the choice was to swap the server for something more conventional, or write the provider myself.

I wrote the provider. It's about three hundred lines, and most of them turned out to be things I would have had to understand anyway.

## The framing

The whole protocol is one byte at the front.

```
byte 0        : 0 = SYNC, 1 = AWARENESS
remaining     : y-protocols payload
```

That's it. Two channels sharing one socket.

SYNC carries document updates. AWARENESS carries presence, which is the next post. Everything after the first byte is handed to the relevant y-protocols function, which already knows how to read it.

Encoding a message means writing the type byte, then letting the library write the rest:

```ts
function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  encoding.writeVarUint(enc, 2)          // messageYjsUpdate
  encoding.writeVarUint8Array(enc, update)
  return encoding.toUint8Array(enc)
}
```

`lib0` handles the actual bytes. Variable length integers, length prefixed arrays, the usual. I never wrote a byte offset by hand.

## The handshake

Two clients connecting to a room have no idea what the other one knows. The sync protocol solves this with two steps.

Step 1 is “here is a summary of what I have”. That summary is a state vector, not the document. It's small.

Step 2 is “here is everything you're missing”, computed from that summary.

The important detail is that both sides do it. The server sends step 1 on connect, the client replies with step 2, and then the client sends its own step 1 so the server can tell it what it missed:

```ts
const syncMsgType = syncProtocol.readSyncMessage(dec, replyEnc, ydoc, this)

if (encoding.length(replyEnc) > 1) {
  this.ws?.send(encoding.toUint8Array(replyEnc))
}

if (syncMsgType === 0) {
  // We just answered the server's step1.
  // Now ask for what we're missing.
  this.ws?.send(encodeSyncStep1())
}

if (syncMsgType === 1) {
  this.setState('SYNCED')
}
```

The `encoding.length(replyEnc) > 1` check is there because the encoder always has the type byte in it. Anything longer than one byte means there's an actual reply to send.

After that, everything is just type 2 messages flowing both ways.

## The bug that cost me an evening

```ts
ws.binaryType = 'arraybuffer'
```

One line. If you leave it out, the browser defaults to `blob`.

Nothing throws. The socket connects. The handshake appears to run. The updates arrive and decode into garbage, and Yjs quietly fails to apply them, and two tabs sit there showing different drawings with no error in either console.

It has to be set before the first message arrives, so it goes immediately after the constructor:

```ts
const ws = new WebSocket(wsUrl)
ws.binaryType = 'arraybuffer'   // default 'blob' corrupts binary data
this.ws = ws
```

There's a comment above it in the source that is longer than the line itself. It earned that.

## The other one, on the server

uWebSockets.js is fast partly because it doesn't allocate a fresh buffer for every message. The ArrayBuffer you get in the message handler is borrowed. It's valid during the callback and not after.

If you hold onto it, queue it, or hand it to anything asynchronous, you are reading memory that now belongs to a different message.

So the rule is: copy on entry, never pass the raw reference anywhere.

Every function in the protocol module has a version of this comment on it, because it is not the kind of bug you want to debug twice.

## A socket is untrusted input

The room URL is public. Anyone can connect and send anything.

The document layer is safe, since Yjs will reject malformed updates. But the framing layer is mine, so it validates:

```ts
if (data.byteLength === 0) {
  throw new ProtocolValidationError('Empty WS payload')
}

const msgType = safeReadVarUint(dec, 'outer message type')
```

And then, for each branch:
- The sync subtype has to be 0, 1 or 2, nothing else  
- There must be no trailing bytes after the payload  
- Awareness payloads have a size cap, configurable, defaulting to 128KB  
- Decode failures become a typed error rather than a stack trace out of lib0  

The trailing bytes check is the one I nearly skipped. It looks pedantic. But without it a message can carry a valid prefix and then arbitrary junk, and you have no idea what you just accepted.

> A protocol isn't the format you agree to send. It's the list of things you agree to reject.

There's a rate limiter in front of all this too, a token bucket sized around what a real editing session actually produces. That's a server concern and I'll come back to it.

## What I'd tell someone starting this

If y-websocket fits your stack, use it. There is no prize for writing this yourself.

But if it doesn't fit, the protocol underneath is smaller than it looks. One type byte, two message kinds, a two step handshake, and a set of validation rules. The library was doing less magic than I assumed.

What I got out of it was knowing exactly where to look when two tabs disagreed. That turned out to be worth more than the three hundred lines cost.

## Closing thoughts

The transport isn't where collaboration gets hard. It's where collaboration gets *specific*.

Everything above this layer is a document merging with itself. Everything below is bytes. This layer is the only place where a wrong default value silently breaks the whole thing.

In the next post I'll look at the other message type, the one carrying cursors and presence, and why that data deliberately never touches the document.
