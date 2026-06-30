---
title: "Tracing a Job That Outlives Its Request"
description: "Parent and child is a claim about containment. Queued work isn't contained by anything, so it needs a different relationship."
date: 2026-06-30
tags: ["backend", "observability", "opentelemetry", "distributed-systems"]
series:
  name: "What It Takes to Build a Job Queue"
  order: 9
---

The last post ended with a queue 26,457 jobs deep and no way to see inside it.

The obvious answer is distributed tracing. The obvious implementation of distributed tracing doesn't work here, and the reason is interesting.

## Why the normal approach breaks

A trace is a tree. A request comes in, opens a root span, calls a service which opens a child span, hits a database which opens another. Parent contains child. Durations nest. You read the waterfall top to bottom.

That model has an assumption baked in: **the parent is still running while the child runs**.

Job creation and job execution do not satisfy this even slightly.

The request that creates a job finishes in about 30 milliseconds. The job might run two seconds later, or in the load test above, never. Different process. Possibly a different machine. Certainly a different hour.

Making the worker's span a child of the request span requires the request span to stay open until the job completes. So:

- The HTTP request appears to take four minutes  
- Your API latency dashboards are ruined  
- A queue backup makes it look like requests are hanging  
- If the job never runs, the span never closes and the trace is never exported  

That last one is fatal on its own. The most important case, work that never completes, is precisely the case that produces no telemetry.

The relationship isn't containment. The request *caused* the execution and then ended. That's a different thing and OpenTelemetry has a different primitive for it.

## Links

A span link points at another span context without claiming a parent-child relationship. Two independent traces, with a recorded causal connection.

The trace context has to survive the queue, which means it has to be written down. It goes into the job payload at creation time:

```python
carrier: dict[str, str] = {}
inject(carrier)

payload_with_trace = {
    **(job_create.payload or {}),
    "_otel_traceparent": carrier.get("traceparent"),
}
```

`inject` serialises the active span context into a W3C `traceparent` string, which looks like this:

```
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Version, trace id, span id, flags. It's designed to be passed through systems that don't understand tracing, usually as an HTTP header. Here it rides in a JSONB column through PostgreSQL and comes out whenever the job runs.

On the worker side, it gets rebuilt:

```python
def _links_from_traceparent(traceparent: str | None) -> list[Link]:
    """Reconstruct an OTel Link from a W3C traceparent string stored in job payload."""
    if not traceparent:
        return []
    try:
        ctx = extract({"traceparent": traceparent})
        remote_span = trace.get_current_span(ctx)
        span_ctx = remote_span.get_span_context()
        if span_ctx.is_valid:
            return [Link(context=span_ctx)]
    except Exception:
        pass
    return []
```

The broad `except` is deliberate. A malformed traceparent, an old job created before this feature existed, a truncated string. None of those should stop a job from running. Telemetry that can break execution is worse than no telemetry.

And the execution span is a root, not a child:

```python
with tracer.start_as_current_span(
    "job.execute",
    links=links,
    kind=SpanKind.CONSUMER,
) as exec_span:
```

`SpanKind.CONSUMER` is the standard marking for the receiving end of async messaging. Backends know what it means and display it accordingly.

The result is two traces. The API trace ends in 30ms and reports honest latency. The worker trace starts whenever the job actually runs and reports honest execution. A link connects them, so you can navigate from one to the other in either direction.

> Parent and child is a claim about containment. A link is a claim about cause. Queued work is caused by a request, not contained by it.

## The number that matters is on the span

The gap between those two traces is the thing worth measuring, so it's recorded explicitly:

```python
wait_seconds = (started_at - created_at).total_seconds()
...
exec_span.set_attribute("job.wait_seconds", round(wait_seconds, 3))
exec_span.set_attribute("job.queue_source", source)
exec_span.set_attribute("job.attempt_number", attempt)
exec_span.set_attribute("job.priority", job_priority)
exec_span.set_attribute("worker.id", _worker_id)
```

This is where the three timestamps from post 1 pay off. `started_at - created_at` is queue wait. `completed_at - started_at` is execution. Two independent numbers with completely different causes and completely different fixes.

Queue wait growing means not enough workers. Execution time growing means the executor or its dependency is slow. Collapse them into one duration and you cannot tell those apart, which means you cannot tell whether to scale out or investigate.

The load test in post 8 was queue wait, entirely. Execution time never moved.

Attributes rather than separate span names, so you can filter: every high-priority job that waited over 30 seconds, every attempt number greater than 1, everything handled by one particular worker.

## The metrics underneath

Traces show you one job. Metrics show you the shape of all of them.

```python
if h := histogram("job_wait_duration"):
    h.record(wait_seconds, {"job_type": executor_type, "priority": job_priority})
```

The walrus is because instruments are `None` when telemetry isn't configured, which is the case in tests and local runs. It keeps instrumentation from being a hard dependency of the code it instruments.

Histogram buckets are chosen for the range that matters:

```python
View(
    instrument_name="jobqueue_job_wait_duration_seconds",
    aggregation=ExplicitBucketHistogramAggregation(
        [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 1800]
    ),
),
```

Out to 30 minutes, because a backed-up queue produces waits in that range and default buckets top out far below it. A histogram whose largest bucket is 10 seconds tells you only that everything was over 10 seconds, which is the moment it stops helping.

Queue depth is a gauge, polled rather than derived, on its own task:

```python
async def _poll_queues_and_pools(redis, interval: int = 15) -> None:
    while True:
        try:
            set_gauge("queue_depth", {"queue_name": "priority"}, float(await redis.zcard(PRIORITY_KEY)))
            set_gauge("queue_depth", {"queue_name": "fifo"}, float(await redis.llen(FIFO_KEY)))
            set_gauge("queue_depth", {"queue_name": "retry"}, float(await redis.zcard(RETRY_KEY)))
        except Exception:
            pass
        ...
        await asyncio.sleep(interval)
```

Counting enqueues and dequeues would give a depth that drifts, because it misses cancellations, dropped entries, and anything that manipulates Redis outside this code. `ZCARD` is the truth, and it's O(1).

The swallowed exceptions are the same principle as before. A failed metric poll must never take down the worker.

Both counters exist for a reason that only shows up under load: `jobs_created` on the API side and `jobs_completed` on the worker side. The gap between those two rates *is* the queue growing. That's the single most important signal in this system, and it's a subtraction between two counters in different processes.

## What it costs

Being honest about the tradeoff, because it's a real one.

`_otel_traceparent` is stored in the job payload. The payload is a domain field, and it is returned verbatim in the API response. So `GET /api/v1/jobs/{id}` hands the caller a field like this:

```json
{
  "payload": {
    "amount": 99.99,
    "_otel_traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
}
```

Internal telemetry metadata leaking through a public API, inside a user-supplied field. Three problems in one:

It exposes internal trace ids to clients. It means a client sending its own `_otel_traceparent` key would have it silently overwritten. And it couples the payload schema to the observability implementation, so removing tracing later becomes a data migration.

The right place is a dedicated `trace_context` column, or a metadata JSONB separate from the user payload. Either is a small migration and neither is written.

There's a smaller one too: two spans open per job on the happy path, plus more on failure, plus a metric record on every branch. Under load that's real allocation in the hot loop. At one job per second it's irrelevant, and if the worker were ever scaled to where it should be, it would be worth measuring.

## Was it worth it

Yes, and specifically for one thing.

Without linked traces, the load test in post 8 gives you two disconnected facts: the API is fast, and jobs aren't completing. With them, you can take one job id, see the request that created it, see it sitting in the queue with `job.wait_seconds` climbing, and see which worker eventually picked it up.

That turns "the system is slow" into "jobs wait 400 seconds and execute in 2." Those two statements suggest completely different work, and only the second one is actionable.

The link is what makes it one story instead of two graphs you have to correlate by hand.

## Closing thoughts

This is the most technically interesting decision in the project and it came from a small observation: the parent-child model encodes an assumption about time that queues violate.

Once I saw that, the implementation was mechanical. Serialise the context, carry it with the work, rebuild it on the other side, use a link instead of a parent. The insight was recognising that the default model was making a claim that wasn't true.

The cost is that telemetry ended up inside the domain payload, which is exactly the kind of shortcut that's invisible when you make it and awkward once it's in a public API.

One post left. What this system honestly guarantees, everything on the list I didn't finish, and what I'd change if I started again.
