---
title: "The Missing Layer Between AI Planning and AI Coding"
description: "I used one AI chat to think and separate agents to build. Cursor Projects turns the handoffs I managed by hand into the product."
date: 2026-09-11
tags: ["ai", "cursor", "coding-agents", "developer-tools", "software-engineering"]
image: "/images/cursor-projects-coordinator.svg"
imageAlt: "A manual AI workflow where the developer carries plans and results between a thinking chat and implementation agents, compared with Cursor Projects using one coordinator and shared context"
imageWidth: 1200
imageHeight: 630
---

For a while, one part of my AI coding workflow belonged entirely to me because no product owned it.

I would open a long conversation with GPT or Claude and use it to think through an idea. Not to write the code yet. I wanted it to question the idea, find the weak parts, compare a few approaches, and help me turn the useful version into a plan.

Once the plan felt solid, I would take pieces of it to separate agents.

One agent might handle the backend. Another would work on the interface. A third would investigate something neither of us understood well enough. When they finished, I would bring their commits, discoveries, and failures back to the original conversation and decide what to do next.

The first chat was where the project thought.

The other agents were where it worked.

I was the thing connecting them.

That workflow is why [Cursor Projects](https://cursor.com/blog/projects) caught my attention. Cursor says a Project can maintain context over months, delegate work to thousands of agents, and act on recurring events without waiting for another prompt.

The thousands-of-agents part is the obvious headline.

The coordinator in the middle is the actual product.

## The workflow already existed

What I was doing looked roughly like this:

```text
brainstorm with GPT or Claude
          ↓
turn the discussion into a plan
          ↓
copy parts of the plan into separate agents
          ↓
collect their code, questions, and failures
          ↓
carry the important parts back to the original chat
```

It works surprisingly well.

It also makes the human a message bus.

Every handoff depends on me noticing what matters. A decision that was obvious after forty minutes of discussion becomes three lines in another agent's prompt. An implementation agent discovers that the plan is wrong, but the other agents keep working from the old version until I relay the change. One branch finishes and I have to reconstruct enough of its reasoning for the original chat to review it properly.

The agents can work in parallel. Their understanding does not automatically stay in sync.

> Starting more agents is easy. Keeping one project coherent while they work is the hard part.

That is the missing layer I had been filling manually. I was not only approving decisions. I was copying state between conversations, deciding who needed which part of the history, and rebuilding context every time work crossed a boundary.

## The coordinator has a different job

A Cursor Project gives you one coordinator agent to talk to. The coordinator does not write the code itself. It plans the work, delegates it to other agents, collects what comes back, and stays available while they are working.

That separation matters.

An agent implementing a feature is occupied by the feature. It is reading files, changing code, running tests, and recovering from whatever it broke. If that same agent is also the place where I am supposed to reconsider the architecture, one role keeps interrupting the other.

The coordinator can remain at the level of the project because execution happens elsewhere.

```text
                         you
                          ↕
                    coordinator
                 ↙       ↓       ↘
            research   build    test
                 ↘       ↓       ↙
                  shared context
```

This is very close to the arrangement I had assembled across GPT, Claude, and separate coding agents, with one important difference: the relay is now inside the system.

Most coding-agent improvements make the worker better. A stronger model writes better code, uses tools more reliably, or stays on one task for longer.

Projects is an attempt to improve the organisation around the workers.

## The chat stops being the unit of work

A chat is a useful place to think, but it has the wrong lifecycle for a project.

Chats accumulate history in the order it happened. Projects need the current plan, the decisions that still apply, the commands that actually run, the research worth keeping, and the things everybody has learned since the first plan turned out to be incomplete.

Cursor's answer is a set of shared files that follows the Project across the cloud and local machines its agents use. Agents can add research and artifacts, along with what they learn about the codebase and how the developer prefers work to be done. If one agent figures out how to test a service, later agents can reuse that knowledge instead of rediscovering it.

That sounds like a small distinction from giving every agent a very long transcript. It is not.

A transcript remembers what people said.

A useful project memory remembers what future work needs.

The second one has to be maintained. Old conclusions need to be replaced when the code changes. A failed approach should remain discoverable without becoming the default suggestion forever. Preferences need to be separated from accidents.

Projects does not make that information problem disappear. It gives the information a durable place to live and gives the coordinator responsibility for using it.

That is a much better starting point than my clipboard.

## Cloud for the work, local for the last mile

Each Project runs on its own computer in the cloud. Closing a laptop does not stop it, and it can give separate agents separate machines instead of making them compete for the same local checkout and CPU.

When something really does need the developer's machine, the coordinator can start a local agent to test it there.

That split is practical. A migration across a few hundred pull requests belongs in the cloud. Checking whether a UI feels right beside the local services and data I already have configured may belong on my laptop.

It also makes large-scale delegation possible, but scale by itself is not the interesting guarantee. Ten agents executing a stale plan produce ten branches to unwind. A thousand agents can turn a misunderstanding into infrastructure.

The useful sequence is still the boring one:

```text
understand → plan → delegate → verify → learn → plan again
```

Projects matters if the coordinator can keep that loop intact while the number of workers changes underneath it.

## The project does not end when the feature ships

My old workflow had another clean break in it.

Once the feature was merged, the implementation conversations were effectively over. If a bug appeared two weeks later, I would open a new conversation, explain the system again, and reconstruct why the earlier decisions had been made.

Projects can subscribe to what happens next. The coordinator can follow pull requests, react to CI, watch a Slack channel, or run on a schedule. Cursor describes feature Projects that continue after release by monitoring logs and handling bug reports with the context behind the original work.

That turns maintenance into a continuation rather than a cold start.

It is also where the name starts to feel accurate. A feature is not the code between the first commit and the merge. It is the design, the implementation, the review, the rollout, the bug that appears later, and the decision about whether that bug reveals a local mistake or a bad assumption in the original plan.

The project outlives any one agent that worked on it.

Its memory should too.

## The numbers need time

Cursor says it has used Projects internally for several months, including migrations across hundreds of pull requests and ongoing design-system work. The company reports that new Projects users merge 30% more pull requests and that people who primarily use Projects merge six times as many.

Those are interesting product numbers. They are not yet a controlled answer to whether Projects makes any particular team six times more productive. The people who move most of their work into a new agent product are probably not representative, and pull-request volume is not the same thing as useful software.

The harder questions will take longer to answer.

Does shared context stay accurate after months of work, or does it become a confident archive of old assumptions? Can the coordinator notice when two individually correct changes do not fit together? Does reviewing artifacts actually reduce the supervision cost, or does the human bottleneck simply move from writing code to checking a flood of pull requests? How much authority should a Project have when it can wake up from a Slack message and change a repository without a fresh prompt?

Cursor's own design-system example says the Project may touch 20 to 100 pull requests a day. At that point, review quality and permission boundaries are not supporting details. They are the system.

Projects is in beta and is rolling out now. I have not used it long enough to answer those questions.

But the shape of the product maps unusually well to the work I was already doing by hand.

## What changes for me

I do not want a system where I describe an idea once, disappear, and accept whatever a fleet of agents decides to build.

The useful parts of my existing workflow were the conversations: pushing on the idea before committing to it, changing the plan when implementation exposed something real, and bringing completed work back into the same place where the tradeoffs were understood.

The waste was everything between those conversations.

Copying the plan. Re-explaining the architecture. Telling three agents about the same changed decision. Finding the one implementation detail that the thinking chat now needed to know. Remembering which agent had tried the approach that failed.

If Projects works, it removes that relay work without removing the discussion.

The human role does not disappear. It moves towards framing the problem, correcting direction, choosing where judgment is required, and reviewing the result. The coordinator owns more of the traffic between those moments.

That is a better division than giving one increasingly large prompt to one increasingly busy agent.

## The thing I would keep

Cursor describes Projects as moving developers up a level of abstraction. That is true, but the abstraction is not “software factory” yet.

It is simpler than that.

The project becomes bigger than the chat.

I can keep one place for the evolving intent, let implementation happen in parallel elsewhere, and return to the same conversation after the code ships. The workers can be temporary. The reason the work exists, the constraints around it, and what the system learned do not have to be.

I do not need thousands of agents for that to be useful.

I need to stop being the glue between five of them.

Before Projects, the original chat held the plan, separate agents held pieces of the execution, and I held the shared memory.

If Cursor gets this right, that last part becomes the product.

---

*Primary sources: Cursor, [“Introducing Projects”](https://cursor.com/blog/projects), September 2026; the [Cursor Projects changelog](https://cursor.com/changelog/projects); and Cursor's documentation on [Cloud Agents](https://cursor.com/docs/cloud-agent) and [subscriptions](https://cursor.com/docs/cloud-agent/capabilities). Product behaviour and usage figures in this post come from Cursor's own reporting. The interpretation and diagram are my own.*
