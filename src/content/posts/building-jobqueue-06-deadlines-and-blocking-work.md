---
title: "A Timeout Doesn't Stop the Work"
description: "Deadlines protect the worker, not the job. Once blocking code is involved, the difference stops being academic."
date: 2026-06-19
tags: ["backend", "python", "asyncio", "reliability"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 6
---

The last post was about work that fails. This one is about work that does something worse: neither fails nor finishes.

A job hits an endpoint that accepts the connection and never responds. No exception, so the retry machinery from post 4 never fires. The worker sits there.

And the worker processes one job at a time. So it isn't one stuck job. It's the whole system.

## Deadlines per executor

Every execution is wrapped:

```python
result = await asyncio.wait_for(
    executor.execute(job_id=job_id, payload=payload),
    timeout=executor.max_execution_seconds,
)
```

The timeout comes from the executor rather than a global setting, because the right deadline is a property of the work:

```python
class BaseExecutor(ABC):
    max_execution_seconds: int = 300

    @abstractmethod
    async def execute(self, job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        ...
```

| Executor | Deadline |
|---|---:|
| `email_send` | 30s |
| `payment_retry` | 60s |
| `report_generate` | 120s |

An SMTP handshake that takes 30 seconds is broken. A report that takes 30 seconds is normal. One number for both would either kill healthy reports or let broken emails hang for two minutes.

There is a global in the config, and it's worth pointing at because it's a small lesson in itself:

```python
job_max_execution_seconds: int = 300     # app/core/config.py:15
```

Documented in the README as a real setting. Read by nothing. Grep the codebase and that line is the only hit. The actual fallback is `BaseExecutor.max_execution_seconds`, which is also 300, so the behaviour is right by coincidence rather than by wiring.

That's worse than not having the setting at all. Someone changes it, deploys, nothing happens, and now they don't trust the config.

## Timeouts are a distinct outcome

A timeout gets its own handler rather than being folded in with other exceptions:

```python
except asyncio.TimeoutError:
    duration_s = (now_utc() - t_start).total_seconds()
    exec_span.set_status(StatusCode.ERROR, "execution timed out")
    exec_span.set_attribute("job.outcome", "timeout")
    if c := counter("jobs_failed"):
        c.add(1, {
            "job_type": executor_type,
            "priority": job_priority,
            "failure_reason": "timeout",
        })
    await handle_failure(
        job_id,
        f"Execution timed out after {executor.max_execution_seconds}s",
        redis,
    )
```

Both paths lead to `handle_failure`, so a timeout is retried like any other failure. What differs is the label. `failure_reason` is a metric attribute, which means the dashboard can separate "the gateway rejected us" from "the gateway never answered."

Those two need completely different responses. Aggregating them into one failure count hides the distinction at exactly the moment you need it.

## The blocking problem

Now the part that bit me.

`report_generate` simulates CPU-and-IO work with a synchronous sleep:

```python
def _generate_report_sync(payload: dict[str, Any]) -> dict[str, Any]:
    time.sleep(random.uniform(1.0, 5.0))
    return {...}
```

`time.sleep` in an async worker is a disaster. It doesn't yield to the event loop, so for up to five seconds nothing else runs. Not the retry drain from post 4. Not the queue depth gauge. Not any other coroutine in the process.

One synchronous call in one executor stalls every async thing in the worker.

The fix is to move it off the loop:

```python
class ReportExecutor(BaseExecutor):
    max_execution_seconds = 120

    async def execute(self, job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _generate_report_sync, payload)
```

`run_in_executor` hands the function to a thread pool and gives back an awaitable. The event loop stays free. The blocking work happens somewhere it can't hurt anything.

This is the standard answer for calling any synchronous library from async code, and the rule that comes out of it is worth stating plainly: in an async worker, every third-party call is blocking until you have confirmed otherwise. Most database drivers, most HTTP clients, most file operations, all of the standard library's compression and hashing. If it doesn't have an async API, it's blocking, and it will stall your loop.

## And here is where the deadline stops working

Put the two mechanisms together and something breaks.

`asyncio.wait_for` cancels a coroutine when the deadline passes. It does that by throwing `CancelledError` into it at its next suspension point.

A thread doesn't have suspension points. Python has no mechanism to interrupt a running thread from outside.

So when a `run_in_executor` call exceeds its deadline, this is what actually happens:

- `wait_for` raises `TimeoutError` in the worker  
- The worker logs the timeout, marks the job, and schedules a retry  
- The worker moves on to the next job  
- **The thread keeps running the report, to completion, unaware that anyone stopped caring**  

The deadline bounded how long the worker waited. It did nothing to the work.

> A timeout is a promise about when you'll stop waiting. It is not a promise about when the work will stop.

The consequences compound. The thread pool has a fixed size, so enough timed-out reports and every thread is occupied by work whose results are being discarded. Meanwhile the job has been retried, so a second copy of the same report is now generating alongside the abandoned first one. Both will finish. One result gets written. The other is thrown away after burning the same CPU.

For a simulated report that's waste. For anything with a side effect, a file written, a row inserted, a payment submitted, it's a correctness problem, because the abandoned work still does the thing.

## Is it still worth having

Yes, and the reason is worth being precise about.

The deadline's real job is protecting the worker's availability, not the job's resources. Without it a single hung executor stops the entire queue permanently. With it, the worker loses one thread and keeps draining. That's the difference between degraded and dead, and it's the outcome that matters most in a system with one worker.

It's just that the guarantee is narrower than the name suggests.

The proper fixes all cost something. A bounded thread pool with a rejection policy so timed-out work can't exhaust it. Cooperative cancellation, where the sync function checks a flag between chunks, which only works for code you own. Or running genuinely untrusted blocking work in a subprocess, which can actually be killed.

I did none of them. For simulated executors with no side effects it doesn't matter. The moment `report_generate` writes a real file, it would.

## What this cost elsewhere

There's a second-order effect I only understood after the load testing in post 8.

The retry drain runs once per loop iteration, between jobs. A `report_generate` job occupies the worker for up to five seconds. During that time no retries are promoted, no matter how overdue.

So the retry schedule from post 4 isn't really a schedule. It's a lower bound. A job due at T runs at T, or when the worker next finishes something, whichever is later. Under load the second term dominates completely, and the carefully computed backoff delays stop describing reality.

Post 4 designed the timing. This post is where the timing quietly stopped being true.

## Closing thoughts

Two mechanisms, each correct on its own, that interact badly.

`wait_for` correctly bounds how long you await something. `run_in_executor` correctly keeps blocking work off the loop. Together they produce a deadline that fires, reports success at protecting the worker, and leaves the work running.

That's the general shape of the problem in this project. Each piece is defensible. The failures live where two pieces meet, and each of those seams needed a decision I didn't know I was making.

In the next post, the biggest seam of them all: the moment between taking a job off the queue and recording that you took it, and what happens when the worker dies inside it.
