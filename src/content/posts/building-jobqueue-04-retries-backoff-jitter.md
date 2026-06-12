---
title: "Retries, Backoff, and Why Jitter Is Not Optional"
description: "Retrying is easy. Deciding when to retry, and making sure everyone doesn't decide the same thing, is the actual work."
date: 2026-06-12
tags: ["backend", "reliability", "distributed-systems", "redis"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 4
---

A job queue exists because work fails. If everything succeeded on the first attempt you would just call the function.

So retries aren't a feature bolted onto this system. They're most of the reason it exists.

## Retrying immediately is worse than not retrying

The instinct is to catch the exception and try again.

That's the wrong move for almost every real failure. The payment gateway returned 504 because it's overloaded. Retrying in a millisecond adds load to something that is already failing because of load. Do it in a loop and you've built a denial of service against your own dependency.

Transient failures need time to stop being true. So the question is never whether to retry, it's how long to wait, and the answer has to grow.

## Exponential backoff, in five lines

```python
import random


def calculate_backoff_with_jitter(attempt: int, max_delay: int = 3600) -> float:
    base = min(2 ** attempt, max_delay)
    return base * (0.5 + random.random())
```

The exponential part is `2 ** attempt`, capped at an hour. The jitter is the multiplier, which lands somewhere in `[0.5, 1.5)`.

| Attempt | Base | Actual delay range |
|---:|---:|---|
| 1 | 2s | 1s to 3s |
| 2 | 4s | 2s to 6s |
| 3 | 8s | 4s to 12s |
| 4 | 16s | 8s to 24s |
| 5 | job is marked failed |

By default `max_attempts` is 5, configurable per job from 1 to 10. A job that fails five times has spent roughly 30 seconds of waiting spread across four retries, which is long enough for a brief outage to resolve and short enough that nobody is left wondering.

One detail worth being precise about: the cap applies to `base`, before jitter. So the genuine maximum delay isn't 3600 seconds, it's 3600 × 1.5 = 5400. That's harmless here but it's the kind of thing that surprises you when you're reading a dashboard and the numbers don't match the documentation.

## Jitter is the part people skip

Backoff alone fixes the single-client case and creates a worse group case.

Picture a gateway that goes down for ten seconds, and two hundred jobs fail against it in that window. With pure exponential backoff, every one of those jobs computes the same delay from the same attempt number. Two seconds later, all two hundred retry simultaneously. The gateway, which was just starting to recover, gets hit by the entire backlog at once and falls over again.

Then they all fail together, all wait four seconds, and do it again.

Backoff without jitter doesn't prevent the stampede. It makes the stampede periodic, and it synchronises clients that had no reason to be synchronised.

The `0.5 + random.random()` multiplier spreads two hundred retries across a window instead of a point. That's the whole mechanism, and it's the difference between a recovering dependency and one that gets knocked over every time it tries to come back.

> Backoff decides how long to wait. Jitter decides that not everyone waits the same amount. The second one is what actually protects the thing you're retrying against.

## The retry queue is a schedule

A delayed job needs somewhere to live that isn't the main queue. A second sorted set, scored by when the job becomes eligible:

```python
async def enqueue_retry(redis: Redis, job_id: str, run_at_epoch: float, job_type: str = "") -> None:
    await redis.zadd(RETRY_KEY, {job_id: run_at_epoch})
```

Same data structure as the priority queue, completely different meaning for the score. In `queue:priority` the score is *how important*. In `queue:retry` it's *when*.

That makes "which jobs are due" a range query, which is what sorted sets are for.

## Draining it

Every iteration of the worker loop, before it looks for new work:

```python
async def drain_retry_queue(redis: Redis, limit: int = 10) -> list[str]:
    now = epoch_now()
    due: list[str] = await redis.zrangebyscore(
        RETRY_KEY, min="-inf", max=now, start=0, num=limit
    )

    claimed = []
    for job_id in due:
        removed = await redis.zrem(RETRY_KEY, job_id)
        if removed:
            claimed.append(job_id)

    return claimed
```

The read and the remove are separate, and that's deliberate.

`ZRANGEBYSCORE` is a read, so two workers running it at the same moment both see the same due jobs. `ZREM` returns the number of elements actually removed, so only the worker whose `ZREM` returns 1 has claimed that job. The other gets 0 and skips it.

It's optimistic concurrency using the return value as the claim. Not a transaction, and it costs one round trip per due job rather than one for the batch, but it makes duplicate promotion impossible from this path.

A Lua script would do the read and the removes atomically in one call. That's the better version and I didn't write it.

## Retries take the long way round

A drained job doesn't get executed. It gets put back in the priority queue:

```python
due = await drain_retry_queue(redis)
for jid in due:
    async with AsyncSessionLocal() as session:
        job = await session.get(Job, UUID(jid))
        if job and job.status == JobStatus.QUEUED.value:
            await enqueue_priority(redis, jid, job.priority)
```

Two hops instead of one. It costs a Redis write and a database read per retry.

What it buys is that there's only one execution path. A retried job goes through exactly the same dequeue, status check, and priority ordering as a fresh one. It doesn't jump the queue, it doesn't skip the checks, and there's no second code path that can drift out of sync with the first.

The status check in the middle also means a job cancelled while waiting to retry never comes back.

## Two limits worth knowing

`limit=10`. Each drain promotes at most ten jobs. If a thousand retries come due at once, it takes a hundred loop iterations to work through them. That's fine when the loop spins freely and much less fine when it doesn't.

Which is the second limit: **the drain only runs between jobs**. The worker is single threaded, so while a `report_generate` job is occupying it for five seconds, no retries are being promoted at all. The retry schedule says a job is due at T. What it actually means is "due at T, or whenever the worker next finishes something, whichever is later."

Under any real load those two are very different numbers. Post 8 has the measurement.

## The failure rates are the test

`payment_retry` fails 30% of the time on purpose:

```python
class PaymentExecutor(BaseExecutor):
    max_execution_seconds = 60

    async def execute(self, job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(random.uniform(1.0, 5.0))
        if random.random() < 0.3:
            raise RuntimeError("Payment gateway timeout: upstream returned 504")
        ...
```

With five attempts at 30% each, roughly 0.24% of jobs exhaust their retries and fail permanently. Most succeed on attempt two or three.

Choosing 30% rather than 1% was one of the better decisions in this project. It means the retry machinery runs constantly instead of occasionally, so bugs in it surface during ordinary use rather than during an incident. If the executors always succeeded, all the code in this post would be untested in practice while looking fully covered.

## What's missing

**No dead letter queue.** A job that exhausts its attempts is marked `failed` and sits in the table. Nothing collects permanently failed jobs for inspection or replay. You can query for them, which is most of the value, but there's no mechanism to retry a batch after fixing the underlying cause.

**No distinction between retryable and permanent failures.** Every exception is treated as transient. A 504 from a gateway and a malformed payload that will never parse are both retried five times with backoff. The second one is guaranteed to fail identically every time, and the system spends 30 seconds finding that out.

The fix is a `PermanentError` exception type that `handle_failure` checks for and fails immediately. It's maybe ten lines and it isn't there.

**`next_retry_at` is never cleared.** When a job eventually succeeds, the field keeps whatever value the last scheduled retry had. Anything reading that column on a completed job gets a stale timestamp that looks meaningful.

## Closing thoughts

Backoff and jitter are five lines that I've now written in three different projects, and I still think they're one of the highest leverage things in backend work. Almost every dependency failure is transient, almost every naive retry makes it worse, and the difference is arithmetic.

The retry queue as a sorted set of due times is the other idea worth keeping. Once "when should this happen" is a score, delayed jobs and scheduled jobs and retries are all the same feature.

In the next post: the client retries too, and if you don't handle that you charge somebody's card twice.
