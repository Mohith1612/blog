---
title: "Three Priority Tiers in One Number"
description: "A single Redis sorted set gives strict priority and FIFO inside each tier. Then I checked the arithmetic."
date: 2026-06-09
tags: ["backend", "redis", "algorithms", "queues"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 3
---

The last post was about a gap I didn't close. This one starts with something I got right, and ends somewhere I didn't expect.

The requirement: three priority tiers, high before medium before low, and within a tier the oldest job goes first.

## The obvious approach

Three lists, checked in order.

```python
job = await redis.rpop("queue:high")
if not job:
    job = await redis.rpop("queue:medium")
if not job:
    job = await redis.rpop("queue:low")
```

It works. FIFO is free because lists are ordered by insertion. Priority is free because you check in order.

The cost is three round trips on an empty queue, which is the common case for an idle worker, and every one of them is a network hop. It also spreads the queue across three keys, so "how deep is the backlog" becomes three commands and an addition.

## One sorted set instead

A Redis sorted set orders members by a float score. If you can express your scheduling policy as a number, Redis enforces it for you.

```python
_PRIORITY_WEIGHTS: dict[str, float] = {
    JobPriority.HIGH.value:   0.0,
    JobPriority.MEDIUM.value: 1000.0,
    JobPriority.LOW.value:    2000.0,
}


def priority_score(priority: str) -> float:
    weight = _PRIORITY_WEIGHTS.get(priority, 1000.0)
    return weight + (time.time() / 1e12)
```

Two components in one float.

The **weight** is the coarse part. High is 0, medium is 1000, low is 2000. Any high job scores lower than any medium job, so it sorts first.

The **timestamp** is the fine part, divided by 1e12 to shrink it. A Unix timestamp in 2026 is about 1.78 billion, so dividing by a trillion gives roughly 0.00178. Far too small to reach the next tier 1000 away, but enough to break ties by insertion time within a tier.

Dequeue is one command:

```python
async def dequeue_priority(redis: Redis) -> str | None:
    result = await redis.zpopmin(PRIORITY_KEY, 1)
    if result:
        return result[0][0]
    return None
```

`ZPOPMIN` removes and returns the lowest score atomically. One round trip, and two workers racing on it cannot get the same job. That atomicity is the main thing this design buys, and it's why the whole scheduling policy is worth compressing into a sort key.

Queue depth is `ZCARD`. Removing a cancelled job from anywhere in the queue is `ZREM`, no scanning.

> If you can express your policy as a number, you can stop writing scheduling code and let the data structure do it.

## Then I checked the arithmetic

While writing this post I wanted to state the FIFO resolution precisely, so I worked out how far apart two jobs in the same tier need to be to get distinct scores.

The answer is not what I assumed.

A float64 has about 15 to 16 significant digits. That's a *relative* precision, so the absolute resolution depends on how large the number is. Near zero it's tiny. Near 2000 it is not:

| Tier | Weight | Smallest gap that produces distinct scores |
|---|---:|---:|
| high | 0.0 | sub-microsecond |
| medium | 1000.0 | **~62 ms** |
| low | 2000.0 | **~119 ms** |

At the high tier the timestamp keeps essentially full resolution, because adding it to 0.0 doesn't push it into the coarse part of the float range.

At the low tier, the weight of 2000 eats the mantissa. Two low-priority jobs submitted 50ms apart get **identical scores**.

## What happens on a tie

Redis has a defined answer for equal scores: it orders them lexicographically by member.

The members here are job ids. The job ids are UUID4s.

So when two low-priority jobs tie, they aren't dequeued in insertion order. They're dequeued in the order of two random hex strings.

FIFO within the tier doesn't degrade gracefully under load. It silently becomes arbitrary.

And the load where this bites is exactly the load I tested. Post 8 covers a run creating about 100 jobs a second, which is 10ms apart. That is well inside the 119ms collision window, and the flood in that test was deliberately low and medium priority. Every ordering guarantee I thought I had in that run was fiction.

Nobody noticed because nothing checks. There's no test asserting FIFO within a tier, and no metric that would show it. The jobs all ran. They just didn't run in the order the design claims.

## The fix is a smaller divisor

The problem is entirely the ratio between the weight and the fraction. Shrink the weights and there's mantissa left over:

```python
_PRIORITY_WEIGHTS = {"high": 0.0, "medium": 1.0, "low": 2.0}

def priority_score(priority: str) -> float:
    return _PRIORITY_WEIGHTS.get(priority, 1.0) + (time.time() / 1e12)
```

Tiers a thousand times closer together, the same 0.00178 fraction, and the gap between tiers is still five hundred times larger than the largest timestamp fraction. No tier can bleed into another, and the fine part survives.

Better still, don't store an absolute timestamp at all. Store seconds since a fixed project epoch, which is a much smaller number and leaves far more room:

```python
EPOCH = 1_767_225_600          # 2026-01-01T00:00:00Z

def priority_score(priority: str) -> float:
    return _PRIORITY_WEIGHTS[priority] + ((time.time() - EPOCH) / 1e9)
```

Neither change is hard. What made this worth writing about is that the original looks completely correct, passes every test, and is wrong in a way no test was ever going to catch.

## The tradeoff I did know about

Strict priority means a steady stream of high-priority jobs starves the lower tiers indefinitely. Not slowly. Completely. As long as one high job is in the set, no medium job runs.

For this system that's acceptable, because high is meant to be rare and urgent. It stops being acceptable the moment somebody decides all their jobs are urgent, which is what always happens.

The fixes are known. Age-based promotion, where a job's weight decreases the longer it waits, which fits this design nicely since it's just another term in the score. Or per-tier quotas, where the worker takes some fixed ratio from each tier regardless of what's waiting.

Both add complexity to something currently expressible in three lines. I chose the three lines and wrote down the starvation risk, which is the right call for a system with one worker and no real users, and the wrong call for anything else.

## Closing thoughts

The design is still one I like. One key, one atomic pop, policy as a sort key, and priority plus fairness in a single addition.

But this post changed my view of it. The float precision issue is invisible in review, invisible in tests, and only shows up under exactly the burst conditions the priority system exists to handle. I built it in March and found the problem in June, by writing a blog post about how well it worked.

Which is its own argument for writing things down.

In the next post: what happens when a job fails, and why the delay before retrying matters more than the retry itself.
