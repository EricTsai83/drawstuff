#!/usr/bin/env bun

import fs from "node:fs"

const files = process.argv.slice(2)

const hasEmptyCssRuleset = (css) => {
  const skipComment = (start) => {
    const end = css.indexOf("*/", start + 2)
    return end === -1 ? css.length : end + 2
  }

  const skipString = (start, quote) => {
    let index = start + 1

    while (index < css.length) {
      if (css[index] === "\\") {
        index += 2
      } else if (css[index] === quote) {
        return index + 1
      } else {
        index += 1
      }
    }

    return css.length
  }

  let index = 0

  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      index = skipComment(index)
      continue
    }

    const character = css[index]
    if (character === '"' || character === "'") {
      index = skipString(index, character)
      continue
    }

    if (character !== "{") {
      index += 1
      continue
    }

    let contentIndex = index + 1
    while (contentIndex < css.length) {
      if (/\s/.test(css[contentIndex])) {
        contentIndex += 1
      } else if (css.startsWith("/*", contentIndex)) {
        contentIndex = skipComment(contentIndex)
      } else {
        break
      }
    }

    if (css[contentIndex] === "}") return true
    index += 1
  }

  return false
}

if (files.length === 0) {
  console.error("Usage: bun .agents/skills/to-html/scripts/validate-html.mjs <html-file> [...]")
  process.exit(1)
}

let failed = false

for (const file of files) {
  const html = fs.readFileSync(file, "utf8")
  const issues = []

  if (/\sstyle=(?:"[\s;]*"|'[\s;]*')/i.test(html)) {
    issues.push("empty style attribute")
  }

  const styleBlocks = html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)
  for (const [, css] of styleBlocks) {
    if (hasEmptyCssRuleset(css)) {
      issues.push("empty CSS ruleset")
      break
    }
  }

  if (issues.length > 0) {
    failed = true
    console.error(`${file}: ${issues.join(", ")}`)
  } else {
    console.log(`${file}: OK`)
  }
}

if (failed) process.exit(1)
