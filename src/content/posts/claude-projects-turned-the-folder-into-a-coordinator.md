---
title: "Claude Projects Turned the Folder Into a Coordinator"
description: "Claude Projects now directs parallel Claude Code sessions, keeps shared memory, and continues after the laptop closes. Cursor arrived at the same missing layer last week."
date: 2026-09-18
tags: ["ai", "anthropic", "claude", "coding-agents", "developer-tools", "software-engineering"]
image: "/images/claude-projects-folder-to-coordinator.svg"
imageAlt: "Claude Projects changing from a folder of files and chats into a coordinator that directs parallel work threads through shared memory"
imageWidth: 1200
imageHeight: 630
---

Last week, I wrote that [Cursor Projects turned the handoffs between coding agents into the product](/posts/the-missing-layer-between-ai-planning-and-ai-coding).

Anthropic just redesigned Claude Projects around almost exactly the same missing layer.

A Claude Project used to be a self-contained workspace. You put files, instructions, and conversations inside it so every chat started with the right context.

The [redesigned version](https://claude.com/blog/projects-redesigned) is not a folder around several conversations.

It is one conversation that manages several others.

You give the Project a goal. Claude scopes the work, creates parallel threads, reviews what comes back, and assembles the result. Each thread is a Claude Code session in the cloud with its own branch and its own copy of the repository. The main Project chat stays available while they work, even after the laptop closes.

The old Project helped Claude understand the work.

The new Project is responsible for moving it.

That is a much larger change than the word “redesigned” suggests.

## The folder became active

The original Claude Projects model was useful because it gave related chats a common starting point.

```text
project
├── instructions
├── knowledge
├── chat about the API
├── chat about the interface
└── chat about the launch
```

The files and instructions travelled into each conversation. The conversations themselves remained separate. If work in the API chat changed the launch plan, someone still had to carry that decision across.

Usually, that someone was the user.

The redesign changes the direction of control.

```text
                           goal
                            ↓
                    main Project chat
                    scope · route · review
                   ↙         ↓         ↘
              API thread  web thread  mobile thread
                   ↘         ↓         ↙
                   memory · files · results
```

You brief the main chat the way Anthropic says you would brief a chief of staff. Claude decides whether work belongs in a new thread or one that already exists, follows up on the work, and tells you what is finished or waiting on you.

The project is no longer passive context around the work.

It has a job.

> A folder preserves what belongs together. A coordinator decides what happens next.

## The main chat has a different job

The most important separation is between directing work and doing it.

If I ask one coding agent to retire an old API across three repositories, it has to hold the plan, inspect every codebase, edit the callers, run the tests, manage the branches, and explain what should merge first. The same conversation becomes planner, worker, reviewer, and status page.

Claude Projects gives those roles different places to live.

The main chat can stay at the level of the goal. The threads can disappear into a repository and do the implementation. I can monitor the whole Project, or open one thread when a particular migration needs steering.

Anthropic's example is exactly this shape: connect API, web, and mobile repositories, ask Claude to retire a deprecated endpoint, and let it create a thread for each repository. The threads migrate callers, run tests, and open pull requests. The coordinator returns with the order in which those pull requests need to merge.

That last part is the product.

Opening three Claude Code sessions is already possible. Knowing that the mobile change depends on the API change, carrying a discovery from one thread into another, and returning one coherent answer is the work people were doing around those sessions.

The redesign puts Claude in that loop.

## Threads make the parallelism concrete

“Multiple agents” can hide a lot of implementation detail.

Here, a thread is not another message inside one giant conversation. It is a full Claude Code cloud session working on its own branch and its own copy of the repository. A thread can then split its own assignment further with subagents, loops, and workflows.

That gives the system a useful hierarchy.

```text
project goal
    ↓
coordinator
    ↓
thread for one bounded outcome
    ↓
subagents and workflows inside that outcome
```

The hierarchy matters because coordination has a cost. The Project does not need every low-level tool result from every subagent. It needs the decisions, blockers, dependencies, and completed artifacts that can change the wider plan.

It also needs a real isolation boundary between workers.

Separate branches provide one. They do not provide agreement.

Anthropic is explicit that two threads editing the same code can still produce an ordinary merge conflict. The coordinator keeps the work organised, but it does not make concurrent changes commute.

> More agents create more parallel work. They also create more edges where individually sensible work can stop fitting together.

That is why the main chat matters more as the thread count grows, not less.

## Memory is now part of execution

The redesigned Project gives every thread access to shared memory. Over time, Claude can retain that the release moved to Friday, why an export was removed, or who has to approve changes to billing.

It also has a Library that collects files the user adds and artifacts Claude produces.

This is the same distinction that stood out to me in Cursor Projects.

A transcript remembers what happened in one conversation.

A project memory has to preserve what later work needs.

Those are not the same problem. A decision may be correct on Monday and stale by Thursday. One thread may discover that an architectural assumption was wrong while three other threads are already executing against it. A rejected approach should remain findable without becoming the recommendation the next time a similar question appears.

Shared memory reduces repeated prompting only if the shared version stays trustworthy.

The redesign makes that more consequential. Bad context in one chat produces one confused chat. Bad project memory can become the starting point for every worker.

Anthropic also lets users adjust how Claude works: how often it checks in, when it should create a new thread, and how detailed its updates should be. The cloud environment, connectors, plugins, instructions, and model can be configured at the Project level.

That sounds like preference management.

It is also operating policy for a small organisation of agents.

## Cursor and Claude found the same layer

Cursor Projects and redesigned Claude Projects are not identical products.

Cursor introduced the idea from the coding environment outward: one coordinator, a large pool of cloud and local agents, shared project context, and subscriptions that can keep the Project involved after the original feature ships.

Claude is introducing it from the workspace inward. The thing that used to collect files, instructions, and chats now directs Claude Code sessions, and Anthropic plans to carry the redesign into chat and Cowork later.

But the architecture in the middle is strikingly similar.

![Cursor and Claude Projects start from different products and converge on a coordinator, parallel workers, and shared project context](/images/cursor-claude-projects-convergence.svg)

Both products separate the conversation with the user from the sessions doing the implementation. Both give the coordinator durable context. Both run the workers in parallel in the cloud. Both keep the coordinator available while those workers are busy.

Most importantly, both treat coordination as a first-class job rather than another instruction at the top of a coding prompt.

Last week I called that the missing layer between AI planning and AI coding.

This week it looks less like one company's product bet and more like the next interface for agentic work.

The chat box is not going away.

It is becoming the control plane for other chat boxes.

## The seams did not go away

The clean diagram is coordinator at the top, workers underneath, and finished work flowing back up.

The real system still has branches, usage limits, stale assumptions, review queues, and two threads that changed the same file.

Anthropic calls out two of those constraints directly.

Each thread is a full Claude Code session, so a Project running several of them can reach usage limits faster. Users can choose the model and effort level for the coordinator and the worker threads, but parallelism is still compute multiplied, not compute made free.

Threads also run in the cloud today. Running beside local tools, local code, and systems behind a private network is coming later.

Then there are the constraints a launch post cannot settle.

How often does the coordinator create work that should have remained one thread? Can it recognise when a discovery invalidates work already in progress elsewhere? Does reviewing the outputs cost less time than supervising the workers would have? When the memory becomes wrong, can the user see which threads inherited it?

And if every thread can create its own subagents, what is the useful unit of review?

The hardest part of multi-agent work is not starting more work.

It is knowing when the work still belongs to the same plan.

## The beta is narrower than the announcement

Redesigned Projects started rolling out on September 17 in beta to selected Pro and Max subscribers who use cloud sessions in Claude Code and do not already have Projects on the web or desktop.

Anthropic says more Claude Code users on those plans will receive access over the following week. The updated experience will reach the rest of Claude, including Team and Enterprise plans, later. Existing Projects continue working as they do today and will be upgraded as the rollout reaches chat and Cowork.

The beta also has narrower operating boundaries. Code Projects are personal rather than shared, and repositories have to live on github.com with the Claude GitHub App installed and push access available. GitHub Enterprise Server, GitLab, and Bitbucket are not supported. Project threads are not available from the terminal CLI.

I have not used the redesigned version yet.

That matters because most of its value cannot be verified from a product video. The question is not whether Claude can open three threads. It is whether the fourth conversation, two days later, still benefits from the decisions made in the first three.

The architecture is convincing.

The memory and coordination have to earn that architecture over time.

## The thing I would keep

The old Claude Project answered a context question:

What should this conversation know?

The redesigned Project answers an execution question:

Given what we know, what should happen next, where should it happen, and what does the rest of the work need to learn from it?

That is the same transition I saw in Cursor Projects. The individual coding session is becoming a worker behind a longer-lived layer that holds the goal, delegates the work, and absorbs what comes back.

The workers can be temporary because the Project is not.

There is still a human in the loop. Someone has to choose the goal, correct the plan, resolve the consequential ambiguity, and decide whether the result is worth merging. The redesign does not remove that judgment.

It removes the requirement that the human also act as the message bus.

Claude Projects used to give several chats the same folder.

Now one chat directs the others.

That is not a better folder.

It is a different product.

---

*Primary sources: Claude, [“Projects redesigned: from folder to conversation”](https://claude.com/blog/projects-redesigned), September 17, 2026; the Claude Code documentation, [“Let Claude coordinate ongoing work with Projects”](https://code.claude.com/docs/en/claude-projects); and the Claude Help Center, [“What are projects?”](https://support.claude.com/en/articles/9517075-what-are-projects). Product behaviour, rollout details, and usage caveats in this post come from Anthropic's own descriptions. The comparison with [Cursor Projects](/posts/the-missing-layer-between-ai-planning-and-ai-coding) is my interpretation.*
