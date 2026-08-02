#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"

const target = process.argv[2]

if (!target) {
  console.error("Usage: highlight-code-blocks.mjs <path-to-html>")
  process.exit(1)
}

const filePath = path.resolve(target)
let html = fs.readFileSync(filePath, "utf8")

const decodeHtml = (value) =>
  value
    .replace(/<span class="[^"]+">/g, "")
    .replace(/<\/span>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const escapeHtml = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const span = (className, value) => `<span class="${className}">${escapeHtml(value)}</span>`

const keywords = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "satisfies",
  "switch",
  "throw",
  "try",
  "type",
  "while",
  "yield"
])

const literals = new Set(["true", "false", "null", "undefined"])

const highlightTypeScript = (code) => {
  let output = ""
  let index = 0
  let previousNonSpace = ""

  const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char)
  const isIdentifier = (char) => /[A-Za-z0-9_$]/.test(char)
  const nextNonSpace = (position) => {
    while (position < code.length && /\s/.test(code[position])) position += 1
    return code[position] ?? ""
  }
  const emit = (value) => {
    output += escapeHtml(value)
    if (value.trim()) previousNonSpace = value.trim().at(-1) ?? previousNonSpace
  }
  const emitSpan = (className, value) => {
    output += span(className, value)
    if (value.trim()) previousNonSpace = value.trim().at(-1) ?? previousNonSpace
  }

  while (index < code.length) {
    const char = code[index]
    const pair = code.slice(index, index + 2)

    if (pair === "//") {
      const nextLine = code.indexOf("\n", index)
      const end = nextLine === -1 ? code.length : nextLine
      emitSpan("c", code.slice(index, end))
      index = end
      continue
    }

    if (pair === "/*") {
      const close = code.indexOf("*/", index + 2)
      const end = close === -1 ? code.length : close + 2
      emitSpan("c", code.slice(index, end))
      index = end
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      const quote = char
      let end = index + 1
      while (end < code.length) {
        if (code[end] === "\\") {
          end += 2
          continue
        }
        if (code[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
      emitSpan("s", code.slice(index, end))
      index = end
      continue
    }

    if (/\d/.test(char)) {
      let end = index + 1
      while (end < code.length && /[\d._]/.test(code[end])) end += 1
      emitSpan("n", code.slice(index, end))
      index = end
      continue
    }

    if (isIdentifierStart(char)) {
      let end = index + 1
      while (end < code.length && isIdentifier(code[end])) end += 1
      const word = code.slice(index, end)
      const next = nextNonSpace(end)

      if (literals.has(word)) emitSpan("n", word)
      else if (keywords.has(word)) emitSpan("k", word)
      else if (previousNonSpace === ".") emitSpan("p", word)
      else if (next === "(") emitSpan("f", word)
      else if (/^[A-Z]/.test(word)) emitSpan("t", word)
      else emit(word)

      index = end
      continue
    }

    if (/[{}()[\].,:;?=><+\-*|&!]/.test(char)) {
      emitSpan("o", char)
      index += 1
      continue
    }

    emit(char)
    index += 1
  }

  return output
}

const highlightShellLine = (line) => {
  if (/^\s*#/.test(line)) return span("sh-comment", line)

  let output = ""
  let index = 0
  let commandHighlighted = false

  const emit = (value) => {
    output += escapeHtml(value)
  }
  const emitSpan = (className, value) => {
    output += span(className, value)
  }

  while (index < line.length) {
    const char = line[index]

    if (/\s/.test(char)) {
      emit(char)
      index += 1
      continue
    }

    if (char === "#") {
      emitSpan("sh-comment", line.slice(index))
      break
    }

    if (char === "$" && line[index + 1] === " ") {
      emitSpan("sh-prompt", "$")
      emit(" ")
      index += 2
      continue
    }

    if (char === "\"" || char === "'") {
      const quote = char
      let end = index + 1
      while (end < line.length) {
        if (line[end] === "\\") {
          end += 2
          continue
        }
        if (line[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
      emitSpan("sh-string", line.slice(index, end))
      index = end
      continue
    }

    let end = index + 1
    while (end < line.length && !/\s/.test(line[end])) end += 1
    const word = line.slice(index, end)

    if (/^--?[A-Za-z0-9][A-Za-z0-9-]*/.test(word)) {
      emitSpan("sh-flag", word)
    } else if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      emitSpan("sh-var", word)
    } else if (!commandHighlighted) {
      emitSpan("sh-command", word)
      commandHighlighted = true
    } else {
      emit(word)
    }

    index = end
  }

  return output
}

const highlightShell = (code) => code.split("\n").map(highlightShellLine).join("\n")

const inferLanguage = (label, code) => {
  const normalizedLabel = label.toLowerCase()

  if (normalizedLabel.includes("typescript") || normalizedLabel.includes("javascript") || normalizedLabel === "ts") {
    return "typescript"
  }
  if (normalizedLabel.includes("shell") || normalizedLabel.includes("bash") || normalizedLabel.includes("sh")) {
    return "shell"
  }

  if (
    /\b(import|export|const|let|type|interface|function)\b/.test(code) ||
    /=>/.test(code) ||
    /from\s+["'][^"']+["']/.test(code)
  ) {
    return "typescript"
  }

  if (
    /^(\s*(#|\$|bun |pnpm |node |git |rg |cd |mkdir |cp |mv |rm |cat |sed |reviewstuff ))/m.test(code) ||
    /\s--[A-Za-z0-9-]+/.test(code)
  ) {
    return "shell"
  }

  return "plain"
}

html = html.replace(
  /<pre(?:\s+[^>]*)?>(?:<span class="label">([^<]+)<\/span>)?<code>([\s\S]*?)<\/code><\/pre>/g,
  (_match, label = "", codeHtml) => {
    const raw = decodeHtml(codeHtml)
    const language = inferLanguage(label, raw)
    const highlighted = language === "typescript"
      ? highlightTypeScript(raw)
      : language === "shell"
        ? highlightShell(raw)
        : escapeHtml(raw)

    const renderedLabel = label ? `<span class="label">${label}</span>` : ""

    const preClass = language === "plain" ? "" : ` class="language-${language}"`

    return `<pre${preClass}>${renderedLabel}<code>${highlighted}</code></pre>`
  }
)

fs.writeFileSync(filePath, html)
