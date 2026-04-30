---
title: "What Building a Drawing App Taught Me About Performance"
description: "Performance issues don’t show up immediately, they build up quietly until your assumptions stop working."
date: 2026-04-30
tags: ["engineering", "performance", "canvas"]
series:
  name: "What It Takes to Build a Canvas App"
  order: 1
---

I thought it would be easy to build a drawing app. Draw some shapes on a canvas. Take some input. Move on.

That assumption didn't last long.

The first version worked fine on its own. Some figures, some simple sketching, no oddities. But when the app began to address actual usage - freehand input, more objects, continuous updates - the experience began to degrade.

You may experience frame drops. Interactions appeared inconsistent. Little delays all added up.

The problem wasn’t one bug.  It was the way the system was built. 

## The easy way is not enough

The first implementation was a familiar pattern:
- Redraw everything every frame  
- Save raw input for freehand drawing  
- Use the canvas for rendering   

This works when the load is small. But as complexity increases, so does the cost of each frame.

More shapes = more draw calls.  
Freehand input takes more data per shape.  
Each frame does the same work.

Eventually, the system does more useless work than useful work.

## A Different Look at the Problem

The turning point was realizing this wasn’t just a UI problem. \
It was a rendering problem.

Up until then, I was asking:
“How do I make this faster?” \
The better question turned out to be:
> “How do I avoid doing this work in the first place?”

## Reuse instead of recompute

Paths were recalculated every frame, even though nothing had changed.

The system would cache the drawing paths and reuse them, avoiding the same computation over and over again.

The improvement was not dramatic, taken by itself, but it removed a constant source of overhead.

## Only render what you need

There’s no need to draw everything on the canvas all the time.

Rendering what you actually see in the viewport saved a lot of unnecessary work.”

The more objects there are, the more important this becomes. 

## Simplify input data

Freehand drawing produces a large number of points. They don’t really change the shape that much.

The system simplified these paths, while maintaining their visual form, so it had to process and render less data.

Less data, less work per frame.

## The underlying message

None of these changes are particularly complicated on their own.

> Performance is not about speed. It’s the way they fit together that makes the difference. It’s about being deliberate about what you choose to compute.

As soon as that became the focus, the system started to behave more predictably.

## Closing remarks

This project has changed my thoughts on performance on the frontend.

Even in browser-based applications, parts of the system can be treated like a rendering engine, not just UI, to make better decisions.

There’s still more to explore as the system continues to scale, but this change alone made a noticeable difference.

If you want to see it, you can check the project here:  
👉 https://canvas.mohith16.com/