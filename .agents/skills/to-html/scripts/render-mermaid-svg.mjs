#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)

const usage = () => {
  console.error(`Usage:
  bun .agents/skills/to-html/scripts/render-mermaid-svg.mjs [options] < input.mmd

Options:
  --title <text>     Accessible SVG title
  --desc <text>      Accessible SVG description
  --caption <text>   Optional figure caption
  --id <prefix>      Stable id prefix for SVG ids
  --out <file>       Write output to file instead of stdout
  --figure           Wrap SVG in <figure class="flow-figure">

Renderer:
  Uses MERMAID_CLI_BIN when set; otherwise runs:
  bunx --package @mermaid-js/mermaid-cli mmdc
`)
  process.exit(1)
}

const readOption = (name) => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) usage()
  args.splice(index, 2)
  return value
}

const hasFlag = (name) => {
  const index = args.indexOf(name)
  if (index === -1) return false
  args.splice(index, 1)
  return true
}

const title = readOption("--title") ?? "Diagram"
const desc = readOption("--desc") ?? "A diagram generated from Mermaid and inlined as SVG."
const caption = readOption("--caption")
const idPrefix = (readOption("--id") ?? `mermaid-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "-")
const outFile = readOption("--out")
const wrapFigure = hasFlag("--figure")

if (args.length > 0) usage()

const mermaidSource = await Bun.stdin.text()

if (!mermaidSource.trim()) {
  console.error("No Mermaid source received on stdin.")
  process.exit(1)
}

const escapeHtml = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "to-html-mermaid-"))
const inputFile = path.join(tempDir, "diagram.mmd")
const outputFile = path.join(tempDir, "diagram.svg")
const configFile = path.join(tempDir, "mermaid-config.json")

fs.writeFileSync(inputFile, mermaidSource)
fs.writeFileSync(
  configFile,
  JSON.stringify({
    securityLevel: "strict",
    flowchart: {
      htmlLabels: false,
      curve: "basis"
    },
    theme: "base",
    themeVariables: {
      background: "transparent",
      primaryColor: "#FFFFFF",
      primaryTextColor: "#141413",
      primaryBorderColor: "#E3DACC",
      lineColor: "#D97757",
      secondaryColor: "#F0EEE6",
      tertiaryColor: "#FAF9F5",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    }
  }, null, 2)
)

const renderer = process.env.MERMAID_CLI_BIN
const command = renderer || "bunx"
const commandArgs = renderer
  ? ["-i", inputFile, "-o", outputFile, "--configFile", configFile, "--backgroundColor", "transparent"]
  : [
    "--package",
    "@mermaid-js/mermaid-cli",
    "mmdc",
    "-i",
    inputFile,
    "-o",
    outputFile,
    "--configFile",
    configFile,
    "--backgroundColor",
    "transparent"
  ]

const render = spawnSync(command, commandArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
})

if (render.status !== 0) {
  fs.rmSync(tempDir, { recursive: true, force: true })
  console.error(render.stderr || render.stdout || "Mermaid render failed.")
  process.exit(render.status ?? 1)
}

let svg = fs.readFileSync(outputFile, "utf8")

fs.rmSync(tempDir, { recursive: true, force: true })

svg = svg
  .replace(/<\?xml[\s\S]*?\?>/g, "")
  .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
  .trim()

const svgMatch = svg.match(/<svg\b[\s\S]*<\/svg>/i)
if (!svgMatch) {
  console.error("Renderer output did not contain an <svg> element.")
  process.exit(1)
}

svg = svgMatch[0]

// Mermaid emits empty presentation attributes such as style="" and style=";".
// Remove them so the inlined SVG passes HTML/CSS diagnostics.
svg = svg.replace(/\sstyle="[\s;]*"/gi, "")

if (/<script\b/i.test(svg)) {
  console.error("Refusing to inline SVG containing <script>.")
  process.exit(1)
}

const remoteUrls = svg.match(/https?:\/\/[^"'\s)<>]+/gi) ?? []
const disallowedRemoteUrls = remoteUrls.filter((url) => !url.startsWith("http://www.w3.org/"))

if (disallowedRemoteUrls.length > 0) {
  console.error(`Refusing to inline SVG containing remote URLs: ${disallowedRemoteUrls.join(", ")}`)
  process.exit(1)
}

const idMap = new Map()
svg = svg.replace(/\bid="([^"]+)"/g, (_match, id) => {
  const next = `${idPrefix}-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`
  idMap.set(id, next)
  return `id="${next}"`
})

for (const [from, to] of idMap) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  svg = svg.replace(new RegExp(`#${escaped}`, "g"), `#${to}`)
}

const titleId = `${idPrefix}-title`
const descId = `${idPrefix}-desc`

svg = svg
  .replace(/<title\b[\s\S]*?<\/title>/gi, "")
  .replace(/<desc\b[\s\S]*?<\/desc>/gi, "")
  .replace(/<svg\b([^>]*)>/i, (_match, attrs) => {
    if (!/\bviewBox="/.test(attrs)) {
      console.error("Rendered SVG is missing a viewBox.")
      process.exit(1)
    }
    const cleanedAttrs = attrs.replace(/\s(?:role|aria-labelledby|width|height|style)="[^"]*"/g, "")
    return `<svg${cleanedAttrs} role="img" aria-labelledby="${titleId} ${descId}"><title id="${titleId}">${escapeHtml(title)}</title><desc id="${descId}">${escapeHtml(desc)}</desc>`
  })

const output = wrapFigure
  ? `<figure class="flow-figure">\n  ${svg.replace(/\n/g, "\n  ")}${caption ? `\n  <figcaption>${escapeHtml(caption)}</figcaption>` : ""}\n</figure>`
  : svg

if (outFile) {
  fs.writeFileSync(outFile, output)
} else {
  process.stdout.write(output)
  process.stdout.write("\n")
}
