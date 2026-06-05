---
title: "Two Stores, One Job, and the Gap Between Them"
description: "Splitting durable truth from fast dispatch buys a lot. It also creates a dual write I never made atomic."
date: 2026-06-05
tags: ["backend", "postgresql", "redis", "distributed-systems"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 2
---

The last post ended on a split: PostgreSQL holds what a job *is*, Redis holds what should happen *next*.

This post is about why that split is right, and about the thing it breaks that I never fixed.

## What each store owns

PostgreSQL holds everything semantically important. Identity, type, payload, priority, status, attempt counts, retry time, all three timestamps, the last error, the result, and a full log trail per job. Plus the indexes to query any of it:

```python
__table_args__ = (
    Index("idx_jobs_status", "status"),
    Index("idx_jobs_type", "type"),
    Index("idx_jobs_created_at", "created_at"),
    Index(
        "idx_jobs_next_retry_at", "next_retry_at",
        postgresql_where=text("next_retry_at IS NOT NULL"),
    ),
    Index(
        "uq_jobs_idempotency_key", "idempotency_key",
        unique=True, postgresql_where=text("idempotency_key IS NOT NULL"),
    ),
)
```

Redis holds three keys and nothing else:

```python
FIFO_KEY     = "queue:fifo"
PRIORITY_KEY = "queue:priority"
RETRY_KEY    = "queue:retry"
```

Membership and ordering. Job ids, never job bodies. If you flushed Redis right now you would lose the schedule, not the work.

## Why not one store

Both single-store options are defensible and I want to be fair to them.

**PostgreSQL only.** `SELECT ... FOR UPDATE SKIP LOCKED` is a genuinely good queue. It's transactional with the job row, which removes this entire post's problem. It costs you a polling loop, table bloat from high-churn rows, and vacuum pressure. For most systems this is the right answer and it's what I'd reach for first now.

**Redis only.** Fast, simple, one store. You give up durable history, ad hoc queries, and the ability to answer "what happened to this job" after the fact. For a queue where jobs are fire and forget that's fine. For one where the job record is the audit trail it isn't.

The split gives you the strengths of both. It also gives you a write that spans two systems with no transaction around it.

## The worker doesn't trust Redis

Because Redis is a cache of intent rather than a system of record, the worker treats every id it pops as a suggestion:

```python
async with AsyncSessionLocal() as session:
    job = await session.get(Job, UUID(job_id))
    if job is None:
        logger.warning("job_not_found_in_db", job_id=job_id)
        continue
    if job.status != JobStatus.QUEUED.value:
        logger.warning("job_status_not_queued", job_id=job_id, status=job.status)
        continue
```

Two checks, both load bearing.

The first catches ids pointing at rows that don't exist. The second catches jobs that were cancelled, already completed, or picked up by something else between the pop and the fetch.

This is why a stale or duplicated Redis entry degrades into a log line instead of a bug. The queue can be wrong. The database decides.

## Now the gap

Here's the create path, and the ordering is the problem:

```python
session.add(job)

with tracer.start_as_current_span("job.create") as job_span:
    try:
        await session.flush()          # 1. job.id assigned, NOT committed

        redis = get_redis_pool()
        await enqueue_priority(redis, str(job.id), job.priority)   # 2. Redis write

        await session.commit()         # 3. PostgreSQL commit
```

Redis is written at step 2. PostgreSQL commits at step 3. There is no transaction spanning both, and there cannot be.

Two ways this goes wrong:

**The commit fails after the enqueue.** Redis now holds an id for a row that will never exist. A worker pops it, the `job is None` check fires, and it's logged and dropped. Survivable, and only survivable because that check exists.

**The process dies between flush and commit.** The row is rolled back by the database. The Redis entry was already written. Same orphan, same outcome.

The reverse ordering isn't better. Commit first and a crash before the enqueue leaves a row sitting at `queued` that nothing will ever pick up. That failure is worse, because it's silent. Nothing logs it, no worker sees it, and the job just never runs.

I picked the loud failure over the silent one. That's the whole justification, and it isn't much of one.

## It happens twice

The retry path has exactly the same shape:

```python
with tracer.start_as_current_span("queue.enqueue_retry") as retry_span:
    await enqueue_retry(redis, job_id, retry_at)      # Redis first

await _add_log(session, job.id, "warning", ...)
...
await session.commit()                                 # commit after
```

Same dual write, same window, same two outcomes.

## And Redis loss strands everything

The third problem is the one that bothers me most, because the data needed to fix it is already sitting in the database.

If Redis restarts without persistence, every queued id vanishes. PostgreSQL still has hundreds of rows sitting at `queued` with a perfectly good `next_retry_at` on the ones awaiting retry, indexed and ready to query.

Nothing rebuilds from it.

Startup recovery, which post 7 covers, scans only for jobs stuck in `processing`. A job at `queued` and absent from Redis is invisible to it. Those rows stay `queued` forever. The API reports them as pending. They will never run.

The fix is roughly fifteen lines. Query for `status = 'queued'` with no recent activity, re-enqueue. I didn't write it, and the reason is that I built recovery while thinking about worker crashes and never came back to think about Redis crashes.

## What the real fix is

The pattern for this is a transactional outbox, and it's not complicated.

You write the job row and an outbox row in the same PostgreSQL transaction. Now the intent to enqueue is as durable as the job itself, and it commits atomically with it. A separate process reads the outbox and pushes to Redis, marking rows as dispatched. If it crashes, it retries on restart. If it double-dispatches, the worker's status check absorbs it.

It converts a dual write into a single write plus an at-least-once relay, and at-least-once is already what this system provides everywhere else.

> Two stores is one store plus a promise you have to keep by hand. If you don't write the code that keeps it, you don't have two stores. You have two stores that mostly agree.

## Closing thoughts

The split itself is a good decision. Durable queryable truth in one place, fast ordered dispatch in the other, with the database always winning when they disagree. The worker's two-line status check does more reliability work than anything else in the codebase.

But the honest description of the current state is that the two stores are kept in sync by ordering luck and a defensive check, not by a mechanism. The window is small. Small is not the same as closed.

In the next post, something that does work: how a single Redis sorted set gives you three priority tiers with FIFO inside each one, using one number. Along with a precision bug I only found while writing the post.
