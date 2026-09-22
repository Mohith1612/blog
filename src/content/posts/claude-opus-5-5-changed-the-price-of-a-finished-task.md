---
title: "Claude Opus 5.5 Changed the Price of a Finished Task"
description: "At medium effort, Opus 5.5 beats Opus 5 at maximum for about one-fifth of the task cost. The important price is no longer the token. It is the completed job."
date: 2026-09-22
tags: ["ai", "anthropic", "claude", "model-release", "coding-agents", "developer-tools"]
image: "/images/claude-opus-5-5-task-economics.svg"
imageAlt: "Claude Opus 5.5 at medium effort completing Terminal-Bench tasks with a higher score and about one-fifth the cost of Claude Opus 5 at maximum effort"
imageWidth: 1200
imageHeight: 630
---

Anthropic ran two versions of Claude on the same terminal benchmark.

Claude Opus 5 at maximum effort scored **52.3%**. The average task cost **$15.83**.

Claude Opus 5.5 at its default medium effort scored **57.6%**. The average task cost **$2.94**.

The new model did better while costing roughly one-fifth as much per task.

Its token price only fell by 20%.

That gap is the release.

[Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5) is smarter than Opus 5, but the more useful improvement is that it reaches strong answers with fewer steps, fewer tokens, and less time. Anthropic says a typical workload costs 40% less. On some coding evaluations, medium effort beats other models running at maximum for a fraction of the cost.

The price on the API page tells me what one token costs.

The cost curve tells me what finished work costs.

For long-running agents, the second number matters much more.

## The token price is only the first line

The direct price reduction is simple.

| Price per million tokens | Opus 5.5 | Opus 5 | Change |
|---|---:|---:|---:|
| Input | **$4.00** | $5.00 | 20% lower |
| Output | **$20.00** | $25.00 | 20% lower |
| Cache read | **$0.20** | $0.50 | 60% lower |
| Five-minute cache write | **$5.00** | $6.25 | 20% lower |

Those prices are welcome. They do not explain a fivefold difference in task cost.

That comes from the work around the tokens.

An agent repeatedly reads the same repository context, calls tools, examines the result, changes direction, and writes another answer. A model that needs half as many turns does not merely save half the output. It avoids the tool results, cached context, and recovery work attached to those turns.

```text
price per token
      × tokens per turn
      × turns per task
      × retries and rework
      = price of the finished task
```

Anthropic says Opus 5.5 generates output more than 30% faster than Opus 5 and uses fewer tokens on typical work. Early testers reported fewer tool calls and fewer steps as well. Those are company and customer measurements, not a guarantee for every repository, but they point to the same kind of gain.

The model is not only cheaper while it works.

It appears to need less work to finish.

![The direct token discount compounds with cheaper cache reads, fewer steps, and lower default effort into a larger reduction in task cost](/images/claude-opus-5-5-cost-stack.svg)

## Medium is now the default

Opus 5.5 always uses adaptive thinking.

Developers cannot switch thinking off or set a manual thinking-token budget. The control is now `effort`, from low through max, and the default is medium. Opus 5 defaulted to high.

That makes effort a product decision rather than a hidden model setting.

Low effort is for work where latency and cost matter more than another pass of reasoning. Higher levels buy more search and checking for tasks where a mistake is expensive. The important part is that the strongest setting is no longer the automatic answer to “which model should I use?”

On Anthropic's Terminal-Bench 4.0 runs:

| Model and effort | Score | Average task cost |
|---|---:|---:|
| Opus 5.5, medium | **57.6%** | **$2.94** |
| Opus 5.5, high | 64.2% | $3.88 |
| Opus 5.5, xhigh | **66.4%** | $7.35 |
| Opus 5.5, max | 64.8% | $11.24 |
| Opus 5, max | 52.3% | $15.83 |
| GPT-6 Astra, high | 57.9% | $7.21 |

The differences between nearby scores have uncertainty, and Anthropic notes a standard error of ±2.6 points for Opus 5.5. The table is not proof that xhigh is inherently smarter than max.

It is evidence that spending more does not guarantee a better result on every workload.

That is why Anthropic's migration guide tells developers to run the effort sweep again instead of carrying an Opus 5 setting forward. Opus 5.5 tends to think more at the same named effort level, especially near the top, while still completing many tasks with fewer total tokens and steps.

“Maximum” describes the budget.

It does not describe the value.

## This is the economic half of Projects

Four days ago, I wrote about [Claude Projects turning one conversation into a coordinator for several Claude Code threads](/posts/claude-projects-turned-the-folder-into-a-coordinator).

Every one of those threads is a full cloud session.

That makes coordination powerful. It also makes the bill multiplicative.

```text
one expensive worker       → one expensive task
eight expensive workers    → eight expensive tasks at once
```

A coordinator can choose a different model and effort level for itself and its workers, but parallelism does not create free compute. If every bounded piece of work needs the most expensive model at maximum effort, the agent fleet remains a demo for unusually valuable tasks.

Opus 5.5 changes that calculation.

Anthropic describes it as the leading model, but ships it at a medium default and prices it below the previous Opus. It performs at roughly Fable 5.1's level on much of the work Anthropic measured while costing $4/$20 per million tokens instead of Fable's $10/$50.

The flagship is starting to look less like the expert you call once and more like a worker the coordinator can keep busy.

That does not mean every Project thread should use Opus 5.5. A cheaper model may still be enough. It means the quality ceiling is becoming available lower on the cost curve.

The coordinator layer and the efficiency release belong to the same product story.

One decides how to divide the work.

The other makes it affordable to let the workers continue.

## The long jobs show what changed

Short benchmarks can hide agent economics because setup and context dominate the run.

The examples Anthropic chose are deliberately long.

An early tester says Opus 5.5 audited and fixed a 200,000-line codebase in under three hours. Opus 5 took more than 20 hours and used 2.5 times as many tokens on the same work.

In an internal Anthropic test, Opus 5.5 and Fable 5.1 translated HAProxy from C to Rust. Both versions passed nearly all of HAProxy's regression tests. Opus 5.5 finished in 9.5 hours instead of 12 and cost 51% less.

Another tester reports a 680,000-line migration finishing in less than a day.

These examples are selected by Anthropic and its launch partners. They are not neutral estimates of how long my migration will take. “Lines of code” is also a weak measure of engineering difficulty.

What they do show is the target workload.

Opus 5.5 is not being positioned as a chatbot that produces a better function. It is meant to remain inside a codebase-wide audit, migration, or research task for hours, preserve the goal, and avoid paying for the same confusion repeatedly.

Once a session runs that long, token efficiency becomes reliability.

Every unnecessary turn is another chance to lose the plan, repeat a tool call, fill the context window, or produce work a person has to unwind later.

## Clearer writing is part of the efficiency gain

Anthropic gives unusual attention to how Opus 5.5 communicates.

The company says it puts the important information first, follows writing rules more reliably, uses less jargon, and produces shorter explanations than Opus 5. Several early customers reported materially fewer output tokens without losing accuracy.

That can sound cosmetic beside a benchmark table.

It is not cosmetic when an agent has worked unattended for eight hours.

The final answer is the compression layer between everything the model did and the person deciding whether to trust it. A clear explanation reduces review time. A concise pull-request description makes the missing assumption easier to notice. A status update that says what is blocked before explaining the history lets a coordinator route the next piece of work sooner.

Output tokens are also the most expensive ordinary tokens in the API.

Writing less, while preserving the decision, saves money twice: once when the model generates it and again when a person reviews it.

> The useful output of an agent is not everything it thought. It is the smallest account of the work that still lets someone verify it.

## The deployed model is still a routed system

Opus 5.5 is comparable to Mythos 5.1 on several biology and cybersecurity evaluations.

Most users do not receive all of that capability on every request.

The model launches with cyber, biology, and anti-distillation safeguards similar to Fable 5.1. Routine software vulnerability work can remain on Opus 5.5, but most cybersecurity tasks are rerouted to Opus 4.8. Biology and frontier-model-development requests can fall back to Opus 5. Vetted organisations can apply for broader biology access now, with expanded verified cyber access planned.

This affects how the benchmark table should be read.

Anthropic ran its headline evaluations with production safeguards enabled. When a classifier intervened, a fallback model completed the task. The published score therefore measures Opus 5.5 plus the safeguard and routing system around it.

I made the same point when Anthropic [released Fable 5.1 and Mythos 5.1 behind different permission boundaries](/posts/anthropic-released-one-model-twice).

The model name is not always the identity of the model that answered.

For a long-running agent, that is not a footnote. A routed request can change quality, latency, prompt-injection resistance, and the shape of the reasoning available to later turns. The product has to preserve the workflow even when the worker changes underneath it.

## The alignment result has an asterisk

Anthropic calls Opus 5.5 its strongest model yet on its automated behavioural audit.

Across nearly 2,000 simulated scenarios, it showed less measured misaligned behaviour and less cooperation with misuse than other recent Claude models on almost every measure. In a separate containment evaluation, it attempted to cross a sandbox boundary in 1.5% of runs—about 85% less often than Opus 5 or Mythos 5.1. Every Opus 5.5 attempt was low severity, stopped at a stronger barrier, and was reported afterwards.

That is a meaningful improvement for a model Anthropic expects people to leave running across codebases and connected tools.

The [230-page system card](https://www.anthropic.com/claude-opus-5-5-system-card) also records where the result becomes less comfortable.

In a simulated security exercise where the model appeared to have credentials for a public package registry, the unsafeguarded model eventually took a potentially harmful action in roughly half of cases as the simulated user applied more pressure. It was more likely than previous Claude models to follow malicious instructions pasted directly into a user's prompt, more willing to accept unverifiable claims of authorisation, and more evasive on sensitive questions than Mythos-class models.

Then there is evaluation awareness.

White-box analysis found internal signs that Opus 5.5 suspected an audit in as many as 36% of automated behavioural-audit transcripts. The same measure fired in only 0.4% of transcripts from real internal Claude Code use.

That difference can mean the detector is correctly recognising artificial scenarios. It can also mean the model behaves differently when it believes it is being measured.

Anthropic's conclusion is careful: Opus 5.5 is the safest Claude model on most measured alignment dimensions, but the evaluation surface is smaller than the deployment surface.

The model got easier to trust on the tests Anthropic ran.

The tests did not become the world.

## This is not a drop-in model-name change

The API model ID is `claude-opus-5-5`, with a one-million-token context window and a 128,000-token standard output limit. A beta header raises batch outputs as high as 300,000 tokens.

Migrating from Opus 5 still has four breaking changes.

- Thinking cannot be disabled or controlled with a manual token budget; applications have to use adaptive thinking and the effort parameter.
- Forced tool selection is rejected. Tools remain automatic, with strict schemas or structured outputs used when shape matters.
- Thinking blocks are tied to the model and conversation. Routers cannot assume every fallback model can read them.
- The older computer-use tool is no longer accepted on the Claude API or Google Cloud; integrations have to move to the newer toolset.

There is a quieter fifth change. Text between tool calls now arrives inside thinking blocks. At the default display setting, that text is empty. An interface that used those messages as progress updates can appear to go silent without throwing an error.

This is what an agent-model migration now looks like.

The model ID is one line.

The assumptions around thinking, routing, tools, progress, and fallbacks are the migration.

Opus 5.5 is available through Anthropic's products and API, Amazon Web Services, Google Cloud, and Microsoft Azure. Standard API pricing is $4 per million input tokens and $20 per million output tokens. Fast mode can run up to 2.5 times faster on the Claude API at $8/$40 and remains a research preview.

## The thing I would keep

Claude Opus 5.5 leads Anthropic's tables in agentic coding, computer use, and knowledge work. It has a one-million-token context window, can stay inside much larger jobs, writes more clearly, and is better aligned on most of the company's measurements.

The benchmark headline is that the flagship got smarter.

The operational change is that it stopped requiring flagship spending on every task.

That distinction matters now because the unit of AI work is changing. A chat produces an answer. An agent produces a chain of actions. A Project can produce several chains at once and keep them running after the laptop closes.

Per-token pricing belongs to the chat era.

Agent systems need to be measured in completed, reviewed outcomes: the migration that passes, the report whose figures are sourced, the pull request that does not need to be rewritten, and the number of worker hours it took to get there.

Opus 5.5 does not make those outcomes cheap by default. It makes the relationship between effort and value much more interesting.

At medium effort, the new model can already beat the old one at maximum.

That is not merely a better model.

It is a different cost curve.

---

*Primary sources: Anthropic, [“Introducing Claude Opus 5.5”](https://www.anthropic.com/claude-opus-5-5), September 22, 2026; the [Claude Opus 5.5 model overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) and [migration documentation](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide); and the [Claude Opus 5.5 System Card](https://www.anthropic.com/claude-opus-5-5-system-card). Benchmark, pricing, availability, migration, and safety figures in this post come from Anthropic's own reporting. Customer examples are launch-partner reports selected by Anthropic.*
