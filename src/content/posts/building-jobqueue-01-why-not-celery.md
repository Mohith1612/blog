---
title: "Why I Didn't Just Use Celery"
description: "A job queue is a promise that work you accepted will eventually happen. Making that promise honestly is the hard part."
date: 2026-06-02
tags: ["backend", "distributed-systems", "python", "queues"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 1
---

Some requests can't be answered when they arrive.

A user asks you to send an email. Charge a card. Generate a report. None of that belongs inside the request that asked for it, because the request has to return and the work has to happen whether or not anyone is still listening.

The standard answer is a job queue, and the standard advice is to use one that exists. Celery, RQ, Sidekiq, whatever your language has. That advice is correct and I ignored it.

Not because I thought I could do better. Because I wanted to know what those libraries are actually doing, and reading their source told me less than building the smallest version that has all the same problems.

## What goes wrong if you don't

Doing the work inline seems fine until you list the failure modes.

The client waits for however long the work takes, and a payment gateway having a slow day becomes your API having a slow day. If the work fails there's nowhere to put the failure, so you either return an error for something the user already paid for or you swallow it. If the process restarts mid-request the work is gone and nothing records that it was ever supposed to happen.

The queue fixes all three by separating two things that look like one:

- Accepting the work  
- Doing the work  

Accepting is fast, synchronous and must never lose anything. Doing is slow, asynchronous and is allowed to fail repeatedly.

> A queue isn't a data structure here. It's a promise that work you accepted will eventually happen, and every design decision below is about how honestly you can keep it.

## What a job is

The whole system revolves around one table.

```python
class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
```

And a row that tracks everything needed to reason about a job that outlives the request that created it:

```python
class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID]
    type: Mapped[str]                       # which executor runs it
    payload: Mapped[dict]                   # JSONB, passed to the executor
    priority: Mapped[str]                   # high / medium / low
    status: Mapped[str]
    idempotency_key: Mapped[str | None]
    attempts: Mapped[int]
    max_attempts: Mapped[int]
    next_retry_at: Mapped[datetime | None]
    created_at: Mapped[datetime]
    started_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    error: Mapped[str | None]
    result: Mapped[dict | None]
```

Three timestamps rather than one, because the interesting durations are the gaps between them. `started_at - created_at` is how long the job waited, which is a queue health signal. `completed_at - started_at` is how long it ran, which is an executor signal. Collapsing those into one field throws away the ability to tell a slow worker from a busy one.

`attempts` and `max_attempts` sit on the row rather than in the queue, because a job that gets retried needs to remember how many times it has already tried across process restarts.

## The two requirements that fight

Here is the tension the rest of this series is about.

The record of a job has to be **durable and queryable**. It survives restarts. You can ask for every failed `payment_retry` from last Tuesday. It's the thing you point at when someone asks whether the email went out.

The dispatch of a job has to be **fast and ordered**. Which job is next, right now, without scanning. Pop it atomically so two workers never get the same one.

Those are different jobs for different tools. PostgreSQL is very good at the first and merely adequate at the second. Redis is excellent at the second and a poor choice for the first.

So the system uses both, and that decision generates most of the interesting problems in this series. It is also where its worst unfixed gap lives, which is the next post.

## The shape of it

```
POST /api/v1/jobs
      │
      ├─ write row to PostgreSQL        (durable truth)
      └─ push job id to Redis           (fast dispatch)

worker loop
      │
      ├─ pop a job id from Redis
      ├─ load the full job from PostgreSQL
      ├─ run the executor with a deadline
      └─ write the outcome back to PostgreSQL
```

Redis never holds a job. It holds an id and an opinion about when that id should be picked up. Every worker resolves the real thing from PostgreSQL before doing anything, and ignores ids whose row is missing or no longer queued.

That indirection costs a database round trip per job. It buys the ability to treat Redis as a cache of intent rather than a system of record, which matters a lot when Redis loses data.

## Three executors

The work itself is simulated, and I want to be upfront that this is a demonstrator rather than something with real business impact behind it.

```python
class BaseExecutor(ABC):
    max_execution_seconds: int = 300

    @abstractmethod
    async def execute(self, job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        ...
```

`email_send` sleeps and fails 10% of the time. `payment_retry` sleeps and fails 30% of the time. `report_generate` does blocking CPU work in a thread and doesn't fail at all.

The failure rates are the point. A 30% failure rate makes the retry path the common path rather than an edge case, which means every load test exercises the machinery I actually wanted to test. If the executors always succeeded, the retry queue would be dead code that looked like it worked.

## What I already know is wrong

I'll be doing this at the end of every post where it applies, because the interesting parts of this project are the places it doesn't hold up.

The worker processes one job at a time. Not four, not eight. One. There's a `WORKER_CONCURRENCY` setting in the config, it defaults to 4, and it is read by exactly nothing:

```python
worker_concurrency: int = 4        # app/core/config.py:14
```

Grep the codebase for it and that line is the only hit. The README documents it as a real knob. It isn't one.

The consequence is measurable and I measured it: the worker drains roughly one job per second, and the API accepts about a hundred. Post 8 is entirely about the test that made that visible, and about how every API benchmark I ran before it looked perfect.

## Closing thoughts

Building this taught me that the queue is the least interesting part of a job queue. Pushing an id into Redis is one line.

Everything hard is in the promises around it. That the job won't be lost between two databases. That it will be retried but not forever. That accepting the same request twice creates one job. That a crashed worker doesn't strand work in a state nobody cleans up.

Celery has spent fifteen years on those promises. I spent two months and got most of the way to understanding why.

In the next post: why the job lives in two places at once, and the gap between them that I never closed.
