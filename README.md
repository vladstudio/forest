# Forest

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

## Concepts

| Term | Action |
|------|--------|
| **Plant** | Create a worktree from an existing Linear ticket |
| **Seed** | Create a new Linear ticket + worktree in one step |
| **Ship** | Push branch + create PR + move ticket to configured status |
| **Fell** | Merge PR + delete worktree + move ticket to configured status |
| **Water** | Rebase on latest + re-run setup (reinstall deps, re-copy env files) |
| **Survey** | Quick-pick list of all active trees |
| **Commit** | AI-generated commit message from staged diff |
| **Init** | Bootstrapping wizard to create `.forest/config.json` |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR merge via `fell`)
- [`linear`](https://github.com/schpet/linear-cli) CLI (optional — features degrade gracefully without it)

## Setup

Run `Forest: Initialize Forest Config` from the command palette, or manually add `.forest/config.json` to your repo:

```json
{
  "version": 1,
  "treesDir": "~/forest/${repo}",
  "copy": [".env", ".env.local"],
  "setup": "bun install --frozen-lockfile",
  "shortcuts": [
    { "name": "dev", "type": "terminal", "command": "bunx turbo dev", "openOnLaunch": 1 },
    { "name": "claude", "type": "terminal", "command": "claude", "openOnLaunch": 1 },
    { "name": "shell", "type": "terminal" },
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
  "integrations": { "linear": true, "github": true, "linearTeam": "ENG" },
  "linearStatuses": {
    "issueList": ["Triage", "Backlog", "Todo"],
    "onPlant": "In Progress",
    "onShip": "In Review",
    "onFell": "Done"
  },
  "branchFormat": "${ticketId}-${slug}",
  "baseBranch": "origin/main",
  "maxTrees": 10
}
```

Per-developer overrides go in `.forest/local.json` (gitignored):

```json
{
  "ai": {
    "provider": "gemini",
    "apiKey": "YOUR_KEY",
    "model": "gemini-2.0-flash-lite"
  }
}
```

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

### Auto-Fell on Merged PRs

Trees in `review` status with a PR are polled every 5 minutes. When a PR is merged, you get a notification: *"KAD-1234 PR was merged. Clean up?"* → click Fell to remove the worktree automatically.

### Water (Rebase + Refresh)

`Water` now fetches and rebases your tree on the base branch before copying config files and running setup. If the rebase fails, it auto-aborts and shows an error.

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

On tree window open (if AI is configured), Forest auto-generates a 1-2 sentence summary of your tree: branch status, commits behind, PR state, and uncommitted changes. Also available via `Forest: Tree Summary — AI`.

### Configurable Linear Statuses

Customize which Linear states to show in the issues sidebar and which states to set on plant/ship/fell:

```json
"linearStatuses": {
  "issueList": ["Triage", "Backlog", "Todo"],
  "onPlant": "In Progress",
  "onShip": "In Review",
  "onFell": "Done"
}
```

## Usage

All commands are available from the Forest sidebar (tree icon in activity bar) or the command palette (`Cmd+Shift+P` → "Forest: ...").

**Typical workflow:**

1. **Plant** a tree from a Linear ticket (or **Seed** to create a new ticket)
2. A new VSCode window opens with terminals running and ports allocated
3. Code, test, iterate — each tree is fully isolated
4. **Ship** when ready — pushes and creates a PR
5. **Fell** after merge — cleans up worktree, branch, and ticket

Switch between trees from the sidebar. All processes keep running in background windows.

## Commands

| Command | Description |
|---------|-------------|
| `Forest: Seed` | Create new ticket + tree |
| `Forest: Plant` | Tree from existing ticket |
| `Forest: Switch Tree` | Open another tree's window |
| `Forest: Ship` | Push + create PR |
| `Forest: Fell` | Merge PR + cleanup |
| `Forest: Water` | Rebase + refresh deps |
| `Forest: Survey` | List all trees |
| `Forest: Commit — AI Message` | AI-generated commit from staged diff |
| `Forest: Tree Summary — AI` | AI summary of current tree |
| `Forest: Warm Template` | Rebuild node_modules template |
| `Forest: Initialize Forest Config` | Bootstrapping wizard |

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
