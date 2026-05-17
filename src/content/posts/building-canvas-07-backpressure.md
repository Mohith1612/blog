---
title: "What Happens When One Client Can't Keep Up"
description: "Every broadcast loop contains an assumption that send() works. Backpressure is what you build when it doesn't."
date: 2026-05-17
tags: ["backend", "websockets", "performance", "reliability"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 7
---

Six posts of client side work. Now the server.

The server in this project does almost nothing. It holds a Y.Doc per room, applies updates, and sends them to everyone else. The interesting part is the last four words.

## The line with the assumption in it

Broadcasting looks like this:

```ts
broadcast(message: Uint8Array, exclude?: WebSocket<UserData>): void {
  for (const client of this.clients) {
    if (client === exclude) continue
    client.send(message, true)
  }
}
```

Fine on localhost with two tabs. It stays fine right up until one of those clients is on hotel wifi.

`send()` does not mean “delivered”. It means “handed to the socket”. If the receiver isn't draining fast enough, the data sits in a buffer and that buffer grows.

## The failure mode

Picture a room with four people actively drawing, and one of them on a bad connection.

The three fast clients keep producing updates. The server keeps calling `send()` on all four. The slow client's buffer fills, and nothing in that loop notices or cares.

What happens next depends entirely on what you built:

- If you buffer without a limit, the process grows until it's killed  
- If the buffer belongs to the room, one slow client degrades everyone in it  
- If you close the connection at the first sign of trouble, you've kicked someone off for having a worse network  

The first option is the default in most code, and it's the worst one. A queue with no ceiling isn't a queue. It's a memory leak with good manners.

## uWS tells you, if you ask

uWebSockets.js returns a status from `send()`:

- `1` accepted and sent  
- `0` accepted, but backpressure is building  
- `2` dropped, the backpressure limit was hit  

And `getBufferedAmount()` tells you how much is queued for that specific socket right now.

That's enough to make a decision per client instead of per room:

```ts
private sendWithBackpressure(ws: WebSocket<UserData>, message: Uint8Array): void {
  const state = this.backpressureByClient.get(ws)
  if (!state) return

  if (ws.getBufferedAmount() > this.backpressureOptions.maxBufferedBytes) {
    this.enqueueOrDrop(ws, state, message)
    return
  }

  const sendStatus = ws.send(message, true)
  if (sendStatus === 1) return

  this.enqueueOrDrop(ws, state, message)
}
```

The threshold defaults to 256KB, and it's an env var because the right number depends on what you're running on.

## The queue has a ceiling

When a client is over the threshold, messages go into a per client queue instead of the socket. That queue holds 64 messages. After that, new messages are dropped:

```ts
private enqueueOrDrop(ws, state, message): void {
  if (state.queue.length >= this.backpressureOptions.maxQueuedMessages) {
    state.droppedCount += 1
    incCounter('ws_backpressure_drops_total')
    if (state.droppedCount % 10 === 0) {
      logger.warn('ws queue drop due to backpressure', { ... })
    }
    return
  }
  state.queue.push(message)
}
```

Two details in there that took a second pass.

The queue is per client, not per room. A slow client's problem stays contained to that client.

The log fires every tenth drop rather than every drop. A client that's badly behind produces drops continuously, and logging each one turns a network problem into a disk problem.

## Draining

uWS calls a `drain` handler when a socket's buffer has room again. That's when the queue gets flushed:

```ts
handleDrain(ws: WebSocket<UserData>): void {
  const state = this.backpressureByClient.get(ws)
  if (!state || state.queue.length === 0) return

  let sent = 0
  while (state.queue.length > 0 && sent < this.backpressureOptions.drainBatchSize) {
    if (ws.getBufferedAmount() > this.backpressureOptions.maxBufferedBytes) return

    const next = state.queue[0]
    if (!next) return

    const sendStatus = ws.send(next, true)
    if (sendStatus === 1) {
      state.queue.shift()
      sent += 1
      continue
    }
    return
  }
}
```

The batch cap is there because draining the whole queue in one callback just refills the buffer and triggers another drain immediately. You end up with a tight loop that starves everything else on the event loop.

The threshold check inside the loop matters too. `getBufferedAmount()` moves while you're iterating, so checking once at the top isn't enough.

## What dropping actually costs

I want to be honest about this, because it's the part I glossed over when I first built it.

A dropped awareness message is free. It was a cursor position, and another one is coming in 33ms that supersedes it entirely. Presence is designed to tolerate this, which is most of what the last post was about.

A dropped sync message is not free. The server broadcasts diffs, so a client that misses one is now behind, and there is no automatic repair. Its document stays wrong until it reconnects and runs the handshake again, at which point the state vector exchange fills in everything it missed.

So the guarantee is “eventually correct, on reconnect” rather than “always correct”. For a whiteboard where the alternative is the server running out of memory, that's the right trade. For something where a missed update matters, it wouldn't be, and you'd want the server to track per client state vectors and send targeted catch up diffs instead.

I knew which one I was building. It's worth knowing which one you are.

## The other direction

Backpressure bounds what goes out. Rate limiting bounds what comes in.

A room URL is public and a socket is cheap. Without a limit, one client can flood the server as fast as it can write.

It's a token bucket, 300 tokens refilling over 5 seconds:

```ts
// 300 tokens / 5 s = 60 msgs/sec steady-state refill.
// Expected peak during active editing: ~31 shape sync + ~30 throttled awareness = ~61/sec.
// The burst budget (300) absorbs the initial sync handshake without triggering limits.
export const DEFAULT_WS_RATE_LIMIT: WsRateLimitConfig = {
  maxTokens: 300,
  refillWindowMs: 5000,
}
```

Those numbers aren't arbitrary and they aren't independent. The 33ms cursor throttle from the previous post exists because of this budget. Change one and the other stops making sense.

And when the limit is hit, the message is dropped but the connection stays open:

```ts
if (!allowWsMessage(rateLimit)) {
  incCounter('ws_rate_limit_exceeded_total')
  logger.warn('ws message rate limit exceeded', { roomId, userId })
  // Drop the message but keep the connection. Closing on first violation
  // disconnects legitimate users during heavy editing sessions.
  return
}
```

I tried closing on violation first. It works great against a synthetic flood and it disconnects real users during an enthusiastic drawing session. Dropping is the more forgiving failure.

## You cannot tune what you cannot see

None of these thresholds were right on the first attempt. They were all guesses, and the only reason they got better is that each one has a counter behind it:

```
ws_active_sockets
rooms_active
ws_messages_received_total
ws_backpressure_drops_total
ws_rate_limit_exceeded_total
ws_message_errors_total
```

Exposed as plain Prometheus text on `/metrics`. About sixty lines of code, no dependency.

> Every limit you set is a guess. The counter next to it is what turns it into a decision.

Before those existed, “is the server dropping anything” was unanswerable and I was tuning by vibes. After, it's a number that either moves under load or doesn't.

## Closing thoughts

The first three posts in this series were about controlling cost per frame. This is the same instinct pointed at a socket.

You can't make a slow client fast. What you can do is make sure its slowness is bounded, contained to itself, and visible.

Every limit here is a choice about what to sacrifice when you can't keep up. Making that choice deliberately is the whole job. The default, unbounded buffering, is also a choice. It just makes itself.

In the next post: what happens when the client goes away entirely, and why the server throws the document out the moment the room is empty.
