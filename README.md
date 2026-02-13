# Forest

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

## Concepts

| Term | Action |
|------|--------|
| **Plant** | Create a worktree from an existing Linear ticket |
| **Seed** | Create a new Linear ticket + worktree in one step |
| **Ship** | Push branch + create PR + move ticket to "In Review" |
| **Fell** | Merge PR + delete worktree + move ticket to "Done" |
| **Water** | Re-run setup (reinstall deps, re-copy env files) |
| **Survey** | Quick-pick list of all active trees |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR merge via `fell`)
- [`linear`](https://github.com/schpet/linear-cli) CLI (optional — features degrade gracefully without it)

## Setup

Add `.forest/config.json` to your repo:

```json
{
  "version": 1,
  "treesDir": "~/forest/${repo}",
  "copy": [".env", ".env.local"],
  "setup": "bun install --frozen-lockfile",
  "terminals": [
    { "name": "dev", "command": "bunx turbo dev", "autostart": true },
    { "name": "claude", "command": "claude", "autostart": true },
    { "name": "shell", "autostart": false }
  ],
  "browsers": [
    { "name": "App", "url": "http://localhost:${ports.app}", "waitForPort": true }
  ],
  "ports": {
    "baseRange": [14000, 15000],
    "mapping": { "app": "+0", "api": "+1" }
  },
  "env": {
    "APP_PORT": "${ports.app}",
    "API_PORT": "${ports.api}"
  },
  "integrations": { "linear": true, "github": true },
  "branchFormat": "${ticketId}-${slug}",
  "baseBranch": "origin/main",
  "maxTrees": 10
}
```

Per-developer overrides go in `.forest/local.json` (gitignored).

## Usage

All commands are available from the Forest sidebar (tree icon in activity bar) or the command palette (`Cmd+Shift+P` → "Forest: ...").

**Typical workflow:**

1. **Plant** a tree from a Linear ticket (or **Seed** to create a new ticket)
2. A new VSCode window opens with terminals running and ports allocated
3. Code, test, iterate — each tree is fully isolated
4. **Ship** when ready — pushes and creates a PR
5. **Fell** after merge — cleans up worktree, branch, and ticket

Switch between trees from the sidebar. All processes keep running in background windows.

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
