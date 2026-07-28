# Personal Preference

## TypeScript
- Never use `any` unless 100% necessary or specifically instructed.
  
## Commands
- Don't run dev server commands (e.g., `bun run dev`) - assume it's already running.
- Focus on checking commands like `bun run typecheck`, `bun run lint`, etc.

## Package Managers
- Use pnpm  if the project already uses it, otherwise use bun.
- Never use npm or yarn

## Tech Stack Preferences
When uncertain, prefer: Tailwind, TypeScript, Bun, Convex, Clerk, Vercel.

## Code Style
- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.

## General proference
- If asked to do too much work at once, stop and state that clearly.
- If computer use is helpful for completing or verifying work, shell out to gpt-5.5 with Codex for it.

## Source Code Reference

Source code for dependencies and external open-source references may already be cached at `~/.opensrc/`.

Whenever asked to inspect open-source code, check the local opensrc cache first.

- **External open-source repositories:** Before every reference, refresh the cached repository so the reference uses the latest upstream source. Because `opensrc` does not provide an update command, run `opensrc remove <owner/repo>` (if it is already cached), followed by `opensrc fetch <owner/repo>`.
- **Dependency source code:** Do not update it independently. It must stay aligned with the dependency version used by this project, as resolved from the project's manifest and lockfile. Use `opensrc path --cwd . <package>` to locate or fetch that exact version.

Use `opensrc path` to read source:

\`\`\`bash
rg "pattern" $(opensrc path <package>)
cat $(opensrc path <package>)/path/to/file
\`\`\`
