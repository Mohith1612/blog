---
title: "What 'Processing' Means When the Worker Is Gone"
description: "A status column records what a job was doing. It cannot record whether anyone is still doing it."
date: 2026-06-23
tags: ["backend", "distributed-systems", "reliability", "postgresql"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 7
---

Every post so far has assumed the worker keeps running.

It doesn't. Deploys restart it, the VM reboots, the OOM killer picks it. And a worker that dies mid-job leaves a row in the database saying `processing`, which is a claim about the present tense made by a process that no longer exists.

Nothing expires that claim. Without recovery, the job sits there forever.

## Two windows, not one

Taking a job involves several steps that aren't one step:

```python
job_id = await dequeue_priority(redis)        # 1. ZPOPMIN, gone from Redis
...
job = await session.get(Job, UUID(job_id))    # 2. load from PostgreSQL
job.status = JobStatus.PROCESSING.value       # 3. mark it
job.started_at = now_utc()
job.attempts += 1
await session.commit()                        # 4. commit
```

Crash at different points and you get different problems.

**Between 1 and 4** the job has been removed from Redis but is still `queued` in PostgreSQL. Nothing holds it. It isn't in a queue, and nothing scans for rows in this state. It is stranded, permanently, and completely silently.

**After 4**, during execution, the row says `processing` with a `started_at` and no owner. This is the one recovery handles.

Only the second window has a mechanism. The first is a real hole and I'll come back to it.

## Startup recovery

On boot, before the loop starts, the worker looks for jobs that were being processed by a worker that clearly isn't around any more:

```python
threshold = now_utc() - timedelta(minutes=settings.recovery_stuck_threshold_minutes)

result = await session.execute(
    select(Job)
    .where(Job.status == JobStatus.PROCESSING.value)
    .where(Job.started_at < threshold)
)
stuck_jobs = list(result.scalars().all())
```

Default threshold is 10 minutes. For each match, either give up or reschedule:

```python
job.attempts += 1
if job.attempts >= job.max_attempts:
    job.status = JobStatus.FAILED.value
    job.completed_at = now_utc()
    job.error = "Worker crashed; max attempts exhausted during recovery"
    ...
else:
    delay = calculate_backoff_with_jitter(job.attempts)
    job.status = JobStatus.QUEUED.value
    job.next_retry_at = now_utc() + timedelta(seconds=delay)
    await enqueue_retry(redis, str(job.id), epoch_now() + delay)
```

Same backoff function as ordinary retries, so a crash loop can't produce a hot loop. Every recovered job writes a `JobLog` entry too, so the trail shows the interruption rather than silently reappearing.

This part I'm happy with. It's the right instinct: on startup, assume anything mid-flight was yours and clean it up.

The problem is what the mechanism uses to decide.

## Age is not liveness

The only evidence recovery has is `started_at`. Old means dead.

That conflates two completely different things. A worker that crashed 20 minutes ago and a worker that is right now, healthily, 20 minutes into a long job look identical to this query. There is no owner recorded, no lease, no heartbeat, nothing that a live worker refreshes to say it's still there.

With one worker that's survivable, since a restart means the previous one is definitively gone. With two workers it's a bug. Worker B boots, sees Worker A's perfectly healthy in-flight job, decides it's stuck, and requeues it. Now two workers are executing the same job.

The 10 minute threshold is doing all the work here. It's tuned so that no real job runs that long, and the longest deadline in the system is 120 seconds, so it holds. But it holds by arithmetic coincidence between two unrelated constants, not because anything enforces the relationship.

> A status column records what a job was doing. It cannot record whether anyone is still doing it. That needs a lease, and a lease needs an owner and an expiry.

## The double count

There's a bug in the code above that took me a while to see.

`attempts` is incremented when execution starts. Recovery increments it again.

So a job that crashes mid-execution burns two attempts for one execution. With `max_attempts` at 5, three crashes exhaust it, having genuinely run three times rather than five.

You can argue this is a deliberate crash penalty. A job that repeatedly kills its worker probably shouldn't get full retries, and there's a real class of poison-pill jobs where that's exactly right.

I'd like to claim that's what I meant. It isn't. Both increments were written weeks apart, each correct in isolation, and nothing tests attempt counts across a crash. The behaviour is defensible and accidental, which is a combination I've learned to distrust.

## The recovery race

Recovery reads with a plain `SELECT` and writes with an ordinary `UPDATE`. No `FOR UPDATE`, no conditional update.

Start two workers at once, which is what a rolling deploy does, and both run recovery, both select the same stuck rows, and both requeue them. The job goes into the retry queue twice.

The `ZREM` claim from post 4 saves you from executing it twice, since only one worker's removal succeeds. So the damage is bounded to a duplicate queue entry and a duplicated attempt increment.

Bounded by a mechanism in a different file, written for a different reason. That's luck with good hygiene, not a design.

The fix is one query:

```sql
UPDATE jobs
   SET status = 'queued', attempts = attempts + 1
 WHERE status = 'processing'
   AND started_at < :threshold
RETURNING id;
```

Read and write as one atomic statement. Only one worker's rows come back. This is the same lesson as post 5, where the database resolved the idempotency race, applied to a place I didn't apply it.

## Cancellation can be undone

A related race, in the same area.

Cancelling a running job marks it `cancelled` and removes it from the Redis queues. The worker checks for that after a successful execution:

```python
if job.status == JobStatus.CANCELLED.value:
    logger.info("job_cancelled_during_execution", job_id=job_id)
    continue
```

That check exists on the success path and nowhere else. `handle_failure` doesn't have it.

So if a job is cancelled while running, and then throws or times out, `handle_failure` runs, sees attempts remaining, and sets the status back to `queued` with a scheduled retry.

The cancellation is gone. The job runs again. The user cancelled it and it executed anyway.

The window is small: it needs a cancellation and a failure to land in the same execution. `payment_retry` fails 30% of the time, so it isn't as small as it sounds.

The fix is re-reading the status inside `handle_failure` and returning early if it's `cancelled`. Three lines.

Cancellation is cooperative in general here, which is a reasonable choice. Running work isn't interrupted, it's just discarded at the end. But "discarded at the end" needs to hold on every path out of execution, and it only holds on one of them.

## The stranded jobs, again

Back to the first window.

Jobs left `queued` in PostgreSQL but missing from Redis are never recovered. Recovery only queries for `processing`. A `queued` row with no queue entry matches nothing.

They get there two ways: the dual-write gap from post 2, and a crash between the `ZPOPMIN` and the status commit.

And the data to fix it is right there. `next_retry_at` is indexed, `created_at` is indexed, `status` is indexed. A query for jobs sitting at `queued` well past when they should have run is straightforward. Compare against Redis, re-enqueue the missing ones.

Roughly fifteen lines. Not written, because I built recovery thinking about crashed executions and never widened the question to "what else could be inconsistent right now."

That's the honest failure mode: the mechanism handles the case I was imagining when I wrote it, and nothing prompted me to enumerate the others.

## What this adds up to

Putting the whole series together, the delivery guarantee is:

**At-least-once, with best-effort recovery of one of the three ways a job can be interrupted.**

Not exactly-once. Exactly-once across a queue and a database needs either a transaction spanning both, which is the outbox from post 2, or idempotent side effects at the executor level, which none of these executors have.

At-least-once means a job's side effect can happen twice. A worker can send the email, crash before writing `completed`, and recovery will send it again. Nothing in this system prevents that. Real executors would need their own idempotency keys, exactly like the API has in post 5, applied at the point of the side effect.

Which is the honest conclusion: the reliability of a job queue is bounded by the reliability of its executors, and infrastructure can't fix a non-idempotent side effect.

## Closing thoughts

The instinct behind startup recovery was right, and it's more than a lot of systems bother with.

The implementation is a good first draft with three unfinished edges: liveness inferred from age instead of a lease, a race from reading and writing separately, and a whole category of stranded state nobody looks for.

Every one of those has a known fix, and every one is short. What they have in common is that I stopped after handling the failure I had pictured. The others were equally real and just less vivid.

In the next post, the flip side of that: a test designed to fail, which found the thing every test I'd run so far had been quietly hiding.
