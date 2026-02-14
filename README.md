# Forest

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

## Concepts

| Term              | Action                                                              |
| ----------------- | ------------------------------------------------------------------- |
| **New Tree**      | Create a worktree from an existing Linear ticket                    |
| **New Issue+Tree**| Create a new Linear ticket + worktree in one step                   |
| **Ship**          | Push branch + create PR + move ticket to configured status          |
| **Cleanup**       | Merge PR + delete worktree + move ticket to configured status       |
| **Cancel**        | Remove worktree + branch without merging + move ticket to canceled  |
| **Update**        | Rebase on latest + re-run setup (reinstall deps, re-copy env files) |
| **List**          | Quick-pick list of all active trees                                 |
| **Commit**        | AI-generated commit message from staged diff                        |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR merge via `cleanup`)
- [`linear`](https://github.com/schpet/linear-cli) CLI (optional — features degrade gracefully without it)

## Setup

Add `.forest/config.json` to your repo root (tip: ask Claude to generate one for your project):

```json
{
  "version": 1,
  "treesDir": "~/forest/${repo}",
  "copy": [".env", ".env.local"],
  "setup": "bun install --frozen-lockfile",
  "shortcuts": [
    { "name": "dev", "type": "terminal", "command": "bunx turbo dev", "openOnLaunch": 1 },
    { "name": "claude", "type": "terminal", "command": "claude", "openOnLaunch": 1, "allowMultiple": true },
    { "name": "shell", "type": "terminal", "allowMultiple": true },
    { "name": "App", "type": "browser", "url": "http://localhost:${ports.app}", "openOnLaunch": 2 }
  ],
  "ports": {
    "baseRange": [14000, 15000],
    "mapping": { "app": "+0", "api": "+1" }
  },
  "env": {
    "APP_PORT": "${ports.app}",
    "API_PORT": "${ports.api}"
  },
  "integrations": { "linear": true, "github": true, "linearTeam": "KAD" },
  "linearStatuses": {
    "issueList": ["triage", "backlog", "unstarted"],
    "onNew": "started",
    "onShip": "started",
    "onCleanup": "completed"
  },
  "branchFormat": "${ticketId}-${slug}",
  "baseBranch": "origin/main",
  "maxTrees": 10
}
```

Per-developer overrides go in `.forest/local.json` (should be gitignored):

```json
{
  "ai": {
    "provider": "gemini",
    "apiKey": "YOUR_KEY",
    "model": "gemini-2.0-flash-lite"
  }
}
```

## Generating Config with AI

To set up Forest, ask Claude (or any AI) to read this README and generate `.forest/config.json`. The AI should inspect the repo and ask you:

1. **Where to store trees?** → `treesDir` (default: `~/forest/${repo}`)
2. **Setup command?** → detect from lockfile: `bun install`, `npm install`, `yarn`, `pnpm install`
3. **Files to copy into trees?** → check which of `.env`, `.env.local`, `.envrc` exist
4. **Shortcuts?** → what terminals to open (dev server, claude, shell), any browser URLs
5. **Ports?** → does the project use specific ports? set `baseRange` and `mapping` so each tree gets unique ports
6. **Linear integration?** → yes/no, and team name (e.g. `ENG`)

### Config reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | yes | — | Always `1` |
| `treesDir` | yes | — | Where worktrees live. Supports `~` and `${repo}` |
| `setup` | no | — | Command(s) to run after creating a tree |
| `copy` | no | `[]` | Files to copy from repo root into each tree |
| `shortcuts` | no | `[]` | Terminals, browsers, files to open per tree |
| `ports.baseRange` | no | `[3000, 4000]` | Port range to allocate from |
| `ports.mapping` | no | `{}` | Named ports as offsets: `{ "app": "+0", "api": "+1" }` |
| `env` | no | `{}` | Extra env vars injected into tree. Supports `${ports.X}` |
| `integrations` | no | `{ linear: true, github: true }` | Toggle integrations. `linearTeam` is the team **key** (e.g. `KAD`), not the display name — run `linear team list` to find it |
| `linearStatuses` | no | see below | Linear states for issue list and lifecycle transitions. **Must use lowercase** Linear CLI state names: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` |
| `branchFormat` | no | `${ticketId}-${slug}` | Branch naming. Supports `${ticketId}`, `${slug}` |
| `baseBranch` | no | `origin/main` | Branch to rebase on |
| `maxTrees` | no | `10` | Max concurrent worktrees |

**Shortcut types:** `terminal` (with optional `command`, `env`, `allowMultiple`), `browser` (with `url`), `file` (with `path`). All support `openOnLaunch: N` (priority order, `false` to disable). Terminal shortcuts with `allowMultiple: true` open a new instance on each click (no stop/restart buttons).

**Variable expansion in shortcuts:** `${ticketId}`, `${branch}`, `${ports.X}`.

**`local.json`** (gitignored) merges over `config.json` — use for per-dev AI keys and overrides.

## Features

### Tree Health Indicators

The Trees sidebar shows live health info for each tree:

```
KAD-1234  Fix login bug   [dev] · 3↓ · 2h
KAD-5678  Add dark mode    [review] · PR approved · 1d
```

- **N↓** — commits behind base branch
- **Age** — time since last commit
- **PR status** — open, approved, changes requested

### Auto-Cleanup on Merged PRs

Trees in `review` status with a PR are polled every 5 minutes. When a PR is merged, you get a notification: *"KAD-1234 PR was merged. Clean up?"* → click Cleanup to remove the worktree automatically.

### Update (Rebase + Refresh)

`Update` fetches and rebases your tree on the base branch before copying config files and running setup. If the rebase fails, it auto-aborts and shows an error.

### Shortcut Variable Expansion

Shortcuts support `${ticketId}` and `${branch}` variables in commands, URLs, and file paths:

```json
{ "name": "Linear", "type": "browser", "url": "https://linear.app/team/issue/${ticketId}" },
{ "name": "PR", "type": "terminal", "command": "gh pr view ${branch} --web" }
```

### Streaming Setup Output

Setup commands stream their output in real-time to the **Forest** output channel, so you can watch `npm install` progress instead of staring at a spinner.

### Port Conflict Detection

When a tree window opens, Forest checks if any allocated ports are already in use and warns you — including which other tree might be using them.

### Pre-Warm Template

After the first tree runs setup, `node_modules` is saved as a template. Subsequent trees get an instant copy (APFS clonefile on macOS, hardlinks on Linux) before running setup, dramatically speeding up tree creation.

Rebuild the template manually: `Forest: Warm Template` from the command palette.

### AI Commit Messages

Configure an AI provider in `.forest/local.json`, then run `Forest: Commit — AI Message`. It reads your staged diff, generates a commit message, lets you edit it, and commits.

Supported providers: `gemini` (default model: `gemini-2.0-flash-lite`) and `openai` (default: `gpt-4o-mini`).

### AI Tree Summary

On tree window open (if AI is configured), Forest auto-generates a 1-2 sentence summary of your tree: branch status, commits behind, PR state, and uncommitted changes. The summary appears in the **Summary** section of the Forest sidebar. Also available via `Forest: Tree Summary — AI`.

### Claude Code Trust

Claude Code asks for trust confirmation when opening a new workspace. Since each tree creates a new directory, you'd get this prompt for every tree. To avoid it, add your `treesDir` to Claude's trusted directories:

In `~/.claude/settings.json`:
```json
{
  "trustedDirectories": ["/Users/you/forest"]
}
```

Replace the path with your actual `treesDir` (without the `${repo}` part).

### Configurable Linear Statuses

Customize which Linear states to show in the issues sidebar and which states to set on new/ship/cleanup.

**Important:** Use the lowercase state names from the Linear CLI, not the display names from the Linear UI. Run `linear issue list --help` to see valid values: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. For `linearTeam`, use the team **key** (e.g. `KAD`), not the display name — find it with `linear team list`.

```json
"linearStatuses": {
  "issueList": ["triage", "backlog", "unstarted"],
  "onNew": "started",
  "onShip": "started",
  "onCleanup": "completed",
  "onCancel": "canceled"
}
```

## Usage

All commands are available from the Forest sidebar (tree icon in activity bar) or the command palette (`Cmd+Shift+P` → "Forest: ...").

**Typical workflow:**

1. **New Tree** from a Linear ticket (or **New Issue + Tree** to create a new ticket)
2. A new VSCode window opens with terminals running and ports allocated
3. Code, test, iterate — each tree is fully isolated
4. **Ship** when ready — pushes and creates a PR
5. **Cleanup** after merge — removes worktree, branch, and ticket
6. **Cancel** to discard a tree without merging

Switch between trees from the sidebar. All processes keep running in background windows.

## Commands

| Command                       | Description                          |
| ----------------------------- | ------------------------------------ |
| `Forest: New Issue + Tree`    | Create new ticket + tree             |
| `Forest: New Tree`            | Tree from existing ticket            |
| `Forest: Switch Tree`         | Open another tree's window           |
| `Forest: Ship`                | Push + create PR                     |
| `Forest: Cleanup`             | Merge PR + remove tree               |
| `Forest: Cancel`              | Remove tree without merging          |
| `Forest: Update`              | Rebase + refresh deps                |
| `Forest: List`                | List all trees                       |
| `Forest: Commit — AI Message` | AI-generated commit from staged diff |
| `Forest: Tree Summary — AI`   | AI summary of current tree           |
| `Forest: Warm Template`       | Rebuild node_modules template        |

## Install locally

```bash
git clone <repo> && cd forest
bun install
bun run package
npx @vscode/vsce package
code --install-extension forest-0.1.0.vsix
```

## Development

```bash
bun install
# Press F5 in VSCode to launch Extension Development Host
```
