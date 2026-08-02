---
name: improve-html-article
description: Improve a standalone HTML article by tightening structure, prose, and visual design.
disable-model-invocation: true
---

# Improve HTML Article

Use this after a complete standalone HTML article exists.

When called from `to-html`, edit the file directly without asking for confirmation. When used on its own, ask for direction only if the revision goal is ambiguous.

## Revision Pass

1. Check the structure.
   - Make sure concepts appear before ideas that depend on them.
   - For explanatory articles, verify the title and main thread teach the reusable problem; a feature or repository scenario should demonstrate the pattern, not replace it.
   - Prefer one running example.
   - Remove duplicate, stale, or low-value sections.
   - Check every example, command, code block, table, and callout against the article's stated topic. If an element does not directly explain, demonstrate, contrast, or support the core topic, remove it or replace it with a topic-specific example.
   - Avoid generic setup or hello-world examples unless the article's purpose is explicitly introductory setup. Prefer examples whose names, commands, and values make the article's main distinction visible.
   - After each command or code block, the surrounding prose should make clear why it exists. If the reason would be "shows how to run the sample" but running the sample is not the article's topic, omit it.

2. Tighten the prose.
   - Keep paragraphs short and direct.
   - Replace note-dump wording with article wording.
   - Make contrasts, caveats, and recommendations explicit.

3. Improve the design.
   - Strengthen hierarchy with title, deck, headings, spacing, and rhythm.
   - Keep the layout readable on mobile and desktop.
   - Improve tables, callouts, lists, code blocks, and figures so they are easy to scan.
   - If the article needs a richer layout, read `HTML-ARTICLE-DESIGN-PATTERNS.md` and apply the most relevant pattern.
   - Preserve existing static syntax highlighting. Do not replace highlighted code with plain escaped text.
   - Keep CSS and any JavaScript self-contained.

4. Verify the result.
   - The file is still a complete standalone `.html` document.
   - The original language is preserved.
   - Code blocks preserve escaping, indentation, and highlighting markup.
   - The final article is clearer than the draft.
