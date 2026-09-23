---
title: "GPT-6 Sol and Luna Squeezed Out the Middle"
description: "Grok, Claude, and GPT releases landed across two days. The telling change in OpenAI's lineup is the missing Terra tier: Sol now costs what Terra used to cost on input, without Terra being retired."
date: 2026-09-23
tags: ["ai", "openai", "gpt-6", "model-release", "coding-agents", "developer-tools"]
image: "/images/gpt-6-sol-luna-middle-tier.svg"
imageAlt: "The GPT-5.6 lineup had Sol, Terra, and Luna; GPT-6 has Astra, Sol, and Luna. GPT-6 Sol now shares GPT-5.6 Terra's two-dollar input price, although Terra remains available."
imageWidth: 1200
imageHeight: 630
---

Three companies put new models into the same news cycle.

[Grok 4.7](https://x.ai/news/grok-4-7) arrived on September 21. [Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5) and [GPT-6 Sol and Luna](https://openai.com/index/introducing-gpt-6-sol-and-luna/) followed on September 22.

The announcements span two calendar days; their published dates do not establish a literal rolling 24-hour window. The pace is still remarkable: by the time one company's benchmark table is being discussed, another company's new model is already part of the choice.

OpenAI's release looks like a familiar family refresh at first. Sol and Luna inherit advances from GPT-6 Astra, improve on their GPT-5.6 predecessors, and cost much less.

But the model I kept looking for was Terra.

GPT-5.6 had Sol, Terra, and Luna. GPT-6 has Astra, Sol, and Luna. There is no GPT-6 Terra in the announced lineup. More tellingly, GPT-6 Sol now costs **$2 per million input tokens**—exactly the input price of GPT-5.6 Terra—while its output costs **$10 instead of Terra's $12**.

Terra remains in the [GPT-5.6 API](https://developers.openai.com/api/docs/models/gpt-5.6-terra). It is absent from the announced GPT-6 family, where the old middle price point now has a new occupant.

## The $2 slot changed hands

The GPT-5.6 release offered a named step between Sol and Luna: a model for people who wanted more capability than the small tier without paying for Sol. The new family has no Terra equivalent by name, and its pricing tells a more interesting story than the missing label alone.

| Model | Input / 1M tokens | Output / 1M tokens | Position |
|---|---:|---:|---|
| GPT-5.6 Sol | $4.00 | $20.00 | Previous Sol |
| GPT-5.6 Terra | $2.00 | $12.00 | Existing middle tier |
| GPT-5.6 Luna | $0.20 | $1.20 | Previous Luna |
| **GPT-6 Sol** | **$2.00** | **$10.00** | New Sol at Terra's input price |
| **GPT-6 Luna** | **$0.10** | **$0.50** | New low-cost tier |

These are OpenAI's standard short-context API prices. Longer prompts and cache writes have different rates, so the table is a starting point, not a bill estimate.

OpenAI describes Sol and Luna as 50% cheaper than their predecessors' promotional prices. Sol's input and output prices each do fall by half. Luna's input price falls by half; its output price falls from $1.20 to $0.50, a slightly larger reduction. The exact dollars are more useful than the rounded headline.

![GPT-6 Sol takes the two-dollar input slot previously occupied by GPT-5.6 Terra, while GPT-6 Luna lowers the floor](/images/gpt-6-sol-luna-price-ladder.svg)

This does not prove Sol will outperform Terra on every task, nor that Terra has no reason to exist. It does make the old “pay $2 for the balanced model” shortcut less informative. At the same input price, I now have to ask what the new Sol does on *my* work, how much output it produces, and whether the older model has a behavior my application still depends on.

The middle did not disappear from the API.

It got squeezed as a product category.

## Luna is the bigger routing decision

Sol gets the name recognition. Luna may change more agent architecture.

On OpenAI's [DeepSWE 1.1](https://openai.com/index/introducing-gpt-6-sol-and-luna/#coding) runs, Sol at maximum effort scored **68.8%**. Luna at maximum scored **66.6%**. The two results are close enough to make the $0.10/$0.50 Luna price worth testing on real coding work, rather than reserving it for trivial classification and summarisation.

That is not a claim that Luna is a $0.10 replacement for every expensive coding model. Maximum effort can spend many more reasoning tokens than a low-effort call, and a benchmark score does not tell me how often I will need to review or retry the patch. OpenAI also compares these results with Claude Opus 5 and Fable 5, not a fresh run against the Opus 5.5 released the same day.

The better question is where Luna can be trusted *inside* a workflow.

It might read a repository and propose a bounded edit. It might classify test failures, extract facts from tool output, or draft the first pass of a change for Sol to verify. If it completes most of those steps cleanly, the expensive model receives fewer open-ended tasks. If it creates subtle cleanup work, the cheap token bill was an illusion.

I wrote yesterday that [Opus 5.5 changed the price of a finished task](/posts/claude-opus-5-5-changed-the-price-of-a-finished-task). The same unit matters here. The interesting comparison is not a million Luna tokens against a million Sol tokens. It is the cost of getting a correct, reviewable result through the whole chain.

## The cache is part of the model release

OpenAI has put a substantial part of the efficiency story outside the model weights.

GPT-6 cached input reads get a 90% discount. OpenAI says changing reasoning effort or enabling and disabling tools can now preserve the reusable prefix of a conversation instead of breaking the cache. Developers can also set explicit breakpoints to control where that prefix ends.

For an agent, this is not an obscure billing optimization.

The same repository instructions, tool definitions, and earlier context are sent over and over as the task advances. If changing from low effort to high effort forced all of that material through fresh processing again, the model router would pay a penalty every time it made a sensible decision.

```text
same project context → cheap repeated reads
new tool result       → fresh context
harder next step      → higher effort, same cached prefix
```

OpenAI says GitHub saw the share of prompt tokens requiring fresh processing fall by more than 50% across billions of requests over several months. That is a partner-reported result, not a promise for a new application with a different prompt layout. But it explains why a 50% list-price cut can compound into something larger—or fail to, if the workflow does not reuse context.

This is also why the missing Terra tier is interesting. A pricing ladder used to ask me to choose one model and live with it. A cheaper cache and a wider effort range encourage a different design: keep the context, change the effort and worker when the task changes.

## Three launches, three incompatible scoreboards

The September 21–22 wave makes one thing hard to ignore: none of these launch charts is a shared league table.

[xAI prices Grok 4.7](https://x.ai/news/grok-4-7#pricing-and-availability) from $2 per million input tokens and $6 per million output tokens. It reports gains on longer coding and knowledge-work tasks. [Anthropic's Opus 5.5](https://www.anthropic.com/claude-opus-5-5) is $4/$20 and, on its Terminal-Bench run, beats Opus 5 at maximum effort while costing about one-fifth as much per task at its default medium effort. OpenAI prices GPT-6 Sol at $2/$10 and Luna at $0.10/$0.50, then reports its own gains on coding, business workflows, computer use, and factuality.

Each company picks tasks, effort levels, harnesses, and comparison models. OpenAI's launch page says its GPT results came from a research environment or API setup that may differ from production ChatGPT; competitor results came from published reports. The Anthropic model in several OpenAI comparisons is Opus 5, even though Opus 5.5 launched on the same date.

That is not a reason to ignore the results. OpenAI's Sol scoring 60.5% on its OSWorld 2.0 offline partial-reward setup versus 60.3% for Opus 5 at medium effort is a useful signal. So is its claim that Sol roughly halves its predecessor's factual errors on a selected set of user-flagged mistakes. OpenAI explicitly says that factuality set is not representative of ordinary conversations.

The figures tell me what is worth testing.

They do not choose a production model for me.

The practical comparison is an evaluation in the same application, with the same tools, the same context, a fixed review standard, and the same definition of “done.”

## The thing I would keep

GPT-6 Sol and Luna are available through the API as `gpt-6-sol` and `gpt-6-luna`. OpenAI says they are rolling into ChatGPT Work and Codex for eligible paid plans, with Luna in the desktop app for Free and Go users; they were not yet available in ordinary Chat at launch.

The launch also promises clearer, shorter technical answers and fewer misleading claims about coding work than the GPT-5.6 counterparts on OpenAI's difficult alignment evaluations. Those are useful improvements for agents because a person eventually has to understand what the model actually changed. They still need to be checked in the workflow, not inferred from a release note.

The headline of this week is three companies releasing new models across two days.

The product change I would remember is smaller and more concrete.

GPT-6 has no Terra. The new Sol has moved into Terra's old input-price slot, and Luna has pushed the low-cost floor down again.

The middle of the model menu is no longer a stable name or a stable price.

It is a routing decision: which worker, at which effort, with which reusable context, can finish this particular job at the lowest *reviewed* cost?

That is the benchmark I would run before moving a single production request.

---

*Primary sources: OpenAI, [“Introducing GPT-6 Sol and Luna”](https://openai.com/index/introducing-gpt-6-sol-and-luna/), September 22, 2026, and its current [GPT-5.6 Terra API documentation](https://developers.openai.com/api/docs/models/gpt-5.6-terra); xAI, [“Introducing Grok 4.7”](https://x.ai/news/grok-4-7), September 21, 2026; Anthropic, [“Introducing Claude Opus 5.5”](https://www.anthropic.com/claude-opus-5-5), September 22, 2026. Benchmark and customer figures are the companies' own reports. The public dates establish two adjacent release days, not an exact rolling 24-hour interval.*
