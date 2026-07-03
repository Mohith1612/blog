---
title: "The Reliability Envelope I Didn't Finish"
description: "An honest accounting of what this job queue guarantees, what it doesn't, and the config settings that do nothing at all."
date: 2026-07-03
tags: ["backend", "reliability", "engineering", "reflection"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 10
---

Nine posts describing a job queue. This one is about the distance between what it looks like and what it is.

## What it actually guarantees

Stated plainly:

**At-least-once delivery, with best-effort retry and partial crash recovery.**

Not exactly-once. Not durable scheduling. A job accepted by the API will *probably* run, will *probably* be retried if it fails, and *might* run more than once.

Every hedge in that sentence is earned by something specific below.

## The complete list

I kept a running note of these while building. Putting them in one place is uncomfortable, which is most of the reason to do it.

### Durability

**The dual write is not atomic.** Redis is written before the PostgreSQL commit, in both job creation and retry scheduling. A crash in between orphans a queue entry or loses a row. Post 2.

**Nothing rebuilds Redis.** Lose Redis and every queued job is stranded at `queued` in PostgreSQL forever. `next_retry_at` is indexed and never used for reconstruction. Recovery only looks at `processing`. Post 7.

**No outbox, no reconciliation.** The known fix for both of the above. Not written.

### Claiming and recovery

**No lease, no heartbeat.** Liveness is inferred from `started_at` being old. A healthy long-running job and a dead worker are indistinguishable to the recovery query.

**Recovery races across workers.** A plain `SELECT` followed by an ordinary `UPDATE`. Two workers starting together can both recover the same rows. An `UPDATE ... WHERE ... RETURNING` fixes it.

**Attempts are double counted on crash.** Incremented at execution start and again by recovery, so one crash costs two attempts.

**The status transition isn't conditional.** `job.status = PROCESSING` is a read-then-write, not `UPDATE ... WHERE status = 'queued'`.

### Correctness

**Cancellation can be undone.** `handle_failure` never checks for `cancelled`, so a job cancelled while running that then fails or times out gets put back to `queued`. Three lines to fix. Post 7.

**Priority loses FIFO under burst.** Float64 precision means jobs less than ~62ms apart at medium, or ~119ms at low, get identical scores and fall back to Redis's lexicographic tie-break on UUID. Effectively random ordering at exactly the load priority exists for. Post 3.

**All failures are treated as transient.** A malformed payload that can never succeed is retried five times with backoff, identically each time. No `PermanentError` type.

**Timeouts don't stop threads.** `wait_for` cancels a coroutine; `run_in_executor` work keeps running to completion after the deadline fires. Post 6.

### Dead code and dead config

This category bothers me most, because unlike the rest it's not a hard problem. It's just wrong.

| Thing | State |
|---|---|
| `WORKER_CONCURRENCY` | In config, in the README, read by nothing. Worker is single-threaded. |
| `JOB_MAX_EXECUTION_SECONDS` | In config, in the README, read by nothing. Executors carry their own. |
| `queue:fifo` | The worker dequeues from it. Nothing ever enqueues to it. `enqueue_fifo` has zero callers. |
| `_shutdown` event | Set by the SIGTERM handler. `worker_loop` is a bare `while True` that never checks it. |

That last one has a commit message attached to it that says "graceful SIGTERM shutdown."

It isn't. The handler logs and sets an event that nothing reads. On SIGTERM the process dies wherever it is, mid-job, and the job sits at `processing` until recovery finds it ten minutes later. Which does work, so the observable behaviour is tolerable. The claim is still false, and it's false in a commit message where a reader would reasonably trust it.

**`next_retry_at` is never cleared** on success either, so completed jobs carry a stale retry timestamp.

### Operations

**`/health` only proves the process is alive.** It doesn't check PostgreSQL or Redis. An API with a dead database returns `{"status": "ok"}` and stays in the load balancer.

**Rate limiting uses the remote address.** Behind nginx and Cloudflare that's the proxy unless forwarded headers are explicitly trusted and configured. It may be limiting one IP for everyone.

**No dead letter queue.** Permanently failed jobs stay in the table. Queryable, not replayable.

**The race test doesn't exist.** The idempotency `IntegrityError` path, the most interesting branch in the codebase, is verified only by an untracked k6 suite that runs against production and is in no pipeline. Post 5.

## What holds up

The list above is long, so it's worth being equally specific about what I'd defend.

**Idempotency.** Correct under concurrency for a structural reason. The database enforces uniqueness, the loser catches the violation and returns the winner. Verified with 10 VUs colliding on 5 keys, 2,923 requests, zero inconsistencies. The best twenty lines in the project.

**The two-store split, with PostgreSQL winning.** Redis is a cache of intent. Every worker resolves the real job from PostgreSQL and discards ids whose row is missing or no longer queued. Two lines of defensive checking that absorb an entire class of inconsistency.

**Backoff with jitter.** Five lines, and the difference between a dependency that recovers and one that gets knocked over each time it tries.

**The retry queue as a sorted set of due times.** Once "when should this happen" is a score, delayed jobs and scheduled jobs and retries are one feature.

**Linked traces across the async boundary.** Recognising that parent-child encodes an assumption queues violate, and using links instead. Post 9.

**The failure rates in the executors.** 30% on `payment_retry` means the retry machinery runs constantly rather than occasionally. Best testing decision in the project, and it was almost an accident.

## What I'd do differently

**Write the end-to-end test first.** I built an API load suite because it was easy, got 173,000 requests with zero errors, and felt good for a week. It measured the one thing structurally incapable of failing. The test that mattered took an afternoon and inverted my understanding of the system.

**Use the database for claiming, the way I already did for idempotency.** I solved a race correctly in post 5 with a constraint, then hand-rolled read-then-write claiming in the worker and recovery and got it wrong in both. The pattern was already in the codebase. I just didn't recognise the second problem as the same shape as the first.

**Build the outbox at the start.** Retrofitting it means touching creation, retry, and recovery. Starting with it is one table and one relay loop.

**Delete config you haven't wired up.** Four settings that do nothing, two of them documented in the README as real knobs. A setting that lies is worse than a missing one, because someone will change it, deploy, see no effect, and stop trusting the whole configuration.

**Don't write a commit message describing the feature you meant to build.** "graceful SIGTERM shutdown" was aspirational when I wrote it and it's been sitting in the history ever since, quietly wrong.

## The pattern in all of it

Reading the list back, the failures cluster somewhere specific.

Almost nothing here is a bug inside a component. The queue works. The backoff maths is right. The executors do what they say. The tracing is well designed.

Everything on that list lives at a **seam**:

- PostgreSQL and Redis (dual write, stranded jobs)  
- The queue and the worker (claiming, no lease)  
- The success path and the failure path (cancellation resurrection)  
- The coroutine and the thread pool (timeouts that don't stop work)  
- The config and the code (four dead settings)  
- Telemetry and the domain model (traceparent in the public payload)  

Each component was reviewable in isolation and looked fine in isolation. The failures needed two things to be true at once, which is exactly what code review is worst at and what nobody was testing.

> Components fail where you look at them. Systems fail between the places you looked.

The second lesson is smaller and more practical. Every one of these gaps has a known, short fix. Fifteen lines for Redis reconstruction. Three for cancellation. One query for the recovery race. Nothing is blocked on being hard.

They're unfinished because after handling the failure I had pictured, nothing prompted me to enumerate the ones I hadn't. Recovery handles crashed executions because that's what I was imagining when I wrote it. The other two interruption windows are equally real and were just less vivid to me at the time.

The habit worth building isn't "handle failures." It's "list the failures, then handle them," because the first one you think of is rarely the whole set.

## Closing

I set out to understand what Celery is doing. I now have a much better answer than when I started, and most of it is: keeping promises that are harder to keep than they look.

The system runs. It has been up for months, it has processed everything sent to it, and the honest description of it is a demonstrator with a real reliability envelope that I can now describe precisely, including where it ends.

Being able to draw that boundary turned out to be worth more than moving it.

You can try it here:  
👉 https://queue.mohith16.com/

Thanks for reading the series.
