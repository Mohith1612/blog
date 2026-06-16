---
title: "Idempotency Is a Race Until the Database Says Otherwise"
description: "Check-then-insert looks correct and isn't. The only reliable fix is to stop checking and let a constraint decide."
date: 2026-06-16
tags: ["backend", "postgresql", "concurrency", "api-design"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 5
---

The last post was about the system retrying failed work. This one is about the client retrying too, which is a different problem with worse consequences.

A client sends `POST /api/v1/jobs` to charge a card. The connection times out. The client has no idea whether the request landed.

It has two options and both are bad. Retry, and possibly charge twice. Don't retry, and possibly never charge at all.

## The standard answer

The client sends a key it chose, and the server promises that the same key means the same job:

```json
{
  "type": "payment_retry",
  "payload": { "amount": 99.99 },
  "idempotency_key": "payment-order-7842-attempt-1"
}
```

First call creates the job and returns 201. Any later call with that key returns the existing job with 200 and a header saying so.

The contract is simple. Implementing it correctly is where it gets interesting.

## The implementation that looks right

```python
existing = await session.execute(
    select(Job).where(Job.idempotency_key == key)
)
if existing.scalar_one_or_none():
    return existing, False

job = Job(...)
session.add(job)
await session.commit()
return job, True
```

Check whether it exists. If not, create it. This is what everyone writes first, including me.

It's a check-then-act sequence with no lock, which means it has a race, which means under concurrency it does the exact thing it was written to prevent.

## The race, concretely

Two requests with the same key, arriving milliseconds apart:

```
Request A                          Request B
─────────                          ─────────
SELECT ... WHERE key = 'k'
  → no rows
                                   SELECT ... WHERE key = 'k'
                                     → no rows     ← still nothing, A hasn't committed
INSERT job_1
                                   INSERT job_2
COMMIT
                                   COMMIT
```

Two jobs. Two charges. Both requests behaved exactly as designed.

The window between the SELECT and the COMMIT is where this lives, and you cannot close it by being faster or checking again. Checking again just gives you two windows. Every version of "look first, then act" has this problem, because the looking and the acting aren't one operation.

> You cannot make a check-then-act sequence safe by checking harder. You make it safe by making it one act.

## Let PostgreSQL decide

The database can enforce this atomically, because uniqueness is exactly the thing constraints are for:

```python
Index(
    "uq_jobs_idempotency_key",
    "idempotency_key",
    unique=True,
    postgresql_where=text("idempotency_key IS NOT NULL"),
)
```

Partial, because the key is optional. Most jobs have no idempotency key at all, and a plain unique index would be full of NULLs. SQL treats NULLs as distinct so it would technically work, but a partial index is smaller, states the intent explicitly, and doesn't index rows that will never be looked up by that column.

Now the race can't produce two rows. One of the two inserts fails.

## Losing gracefully

Which turns the problem into: what does the loser do?

```python
try:
    await session.flush()
    ...
    await enqueue_priority(redis, str(job.id), job.priority)
    await session.commit()
    return job, True

except IntegrityError:
    await session.rollback()
    existing = await session.execute(
        select(Job).where(Job.idempotency_key == job_create.idempotency_key)
    )
    row = existing.scalar_one()
    logger.debug("idempotency_hit_race", idempotency_key=..., job_id=str(row.id))
    return row, False
```

Catch the violation, roll back, re-select, return the winner's row.

`scalar_one()` rather than `scalar_one_or_none()` is a deliberate assertion. If we got an `IntegrityError` on this constraint, a conflicting row provably exists and is provably committed. If it isn't there, something is wrong that shouldn't be silently converted into a `None`, so raising is correct.

The loser's response is indistinguishable from the winner's. Both callers get the same job id, the same status, and the same replay header. Neither knows it was in a race.

The fast-path `SELECT` at the top of the function stays, by the way. Not for correctness, since the constraint handles that, but because the overwhelming majority of replays are sequential rather than concurrent, and a plain indexed read is much cheaper than an insert that's going to be rolled back.

## What the client sees

```python
job, is_new = await create_job(session, body)

if not is_new:
    response.status_code = 200
    response.headers["X-Idempotency-Replay"] = "true"

return JobRead.model_validate(job)
```

201 for a new job, 200 plus an explicit header for a replay.

The header matters more than it looks. Without it, a client that retried after a timeout gets a 200 and cannot tell whether it created the job or found it. That distinction is often exactly what the client needs to log, alert on, or reconcile against.

## Does it hold up

I ran 10 virtual users against a pool of 5 shared keys for 3 minutes, which means near-constant collisions on every key.

| Metric | Result |
|---|---|
| Total requests | 2,923 |
| Checks passed | 5,846 / 5,846 |
| Inconsistencies | 0 |
| p(95) latency | 231ms |
| Error rate | 0% |

Every replay returned the right job and the correct header.

The latency line is the interesting one. The baseline single-user test measured p(95) at 429ms, and this test came in at 231ms under ten times the concurrency. Replays are faster than creates, because a replay is one indexed read and a create is an insert, a Redis write and a commit. Under a workload that's mostly replays, the average request gets cheaper as concurrency goes up.

## The gap in the testing

The committed test suite verifies sequential replay: create with a key, create again with the same key, assert the same id comes back. That covers the common case and it passes.

It does not exercise the `IntegrityError` path. Nothing in the committed tests ever forces two concurrent inserts to collide, so the most interesting branch in this file, the one this entire post is about, has no unit test behind it.

The k6 run above does exercise it, since 10 VUs on 5 keys collide constantly. But that suite is untracked, runs against production, and isn't in CI. So the race handling is verified by an artifact that no automated pipeline will ever run again.

That's a real hole. The fix is a test that opens two sessions, flushes both, and asserts one raises. Not difficult. Not written.

## Where this pattern generalises

The lesson isn't about idempotency keys. It's about where correctness lives.

Application-level checks are advisory. They're correct when only one thing is happening, which is the condition under which you test them and not the condition under which they run. A database constraint is enforced by the same component that serialises the writes, so it cannot be raced.

Whenever the requirement is "only one of these may exist," the right move is a constraint plus a handler for losing, not a lookup plus hope. The constraint is the mechanism. The lookup is an optimisation.

Idempotency is the clearest instance of this in the project. The pattern shows up everywhere: unique usernames, one-active-subscription rules, single-winner claims on a row.

## Closing thoughts

This is the part of the system I'd defend without qualification. It's twenty lines, it's correct under concurrency for a structural reason rather than a timing one, and it was verified under deliberate collision.

It's also the one place where I put correctness in the database instead of the application. Post 7 is about a place where I didn't, and it shows.

In the next post: what happens when a job doesn't fail and doesn't finish, and why a timeout doesn't stop the work it's timing.
