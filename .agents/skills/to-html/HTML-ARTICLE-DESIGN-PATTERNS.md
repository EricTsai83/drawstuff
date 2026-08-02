---
name: html-article-design-patterns
description: Reference patterns for choosing a clear standalone HTML article layout.
disable-model-invocation: true
---

# HTML Article Design Patterns

Use this only when plain prose is not the clearest shape. Pick one primary pattern.

## Shared Rules

- Keep everything self-contained: inline CSS, inline SVG, and small local JavaScript only.
- Make the opening useful with a clear title and, when helpful, a short deck. Do not automatically add a TL;DR, key-fact card, or summary callout.
- Use visuals to explain content, not decorate it.
- Keep tables, SVGs, code blocks, and controls readable on mobile and desktop.
- Treat every pattern as a palette of possible elements, not a checklist. Include only what supports the article's job.

## Pattern Selector

| Pattern | Use For | Possible Elements |
| --- | --- | --- |
| Compare options | Tradeoffs, alternatives, vendors, approaches | 2-4 option cards, strengths, risks, effort, example, recommendation |
| Implementation plan | Roadmaps, migrations, fixes, rollouts | Scope, decision, risk, estimate, milestones, tests, rollout notes |
| Code review or code map | PR reviews, file tours, module behavior | Risk summary, file sections, annotated excerpts, optional flow diagram |
| Design review | UI direction, components, visual systems | Tokens, swatches, type, spacing, state grids, variant comparisons |
| Explainer | Long conceptual or technical guides | Short deck, optional TOC, running example, code, diagram, glossary, decision rules |
| Report or incident | Status, investigations, retrospectives | Impact, status, timeline, owners, actions, evidence panels where needed |
| Diagram or figure | Architecture, data flow, relationships | Inline SVG, labels, legend, caption, accessible title/description |
| Small tool or editor | Sorting, tuning, filtering, comparing, exporting | Clear controls, visible state, reset/default actions, scoped JavaScript |

## Quality Check

- The pattern matches the article's job.
- Every included element materially helps the reader; no component appears only to fill a template slot.
- The page remains readable without external assets.
- Any code blocks preserve indentation and static highlighting.
