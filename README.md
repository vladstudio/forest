<p align="center">
  <img src="forest.png" width="128" alt="Forest">
</p>

# Forest

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

## Concepts

| Term                        | Action                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| **New Tree**                | Create a worktree from an existing Linear ticket                    |
| **New Linear Issue + Tree** | Create a new Linear ticket + worktree in one step                   |
| **Ship**                    | Push branch + create PR + move ticket to configured status          |
| **Cleanup**                 | Merge PR + delete worktree + move ticket to configured status       |
| **Cancel**                  | Remove worktree + branch without merging + move ticket to canceled  |
| **Update**                  | Rebase on latest + re-run setup (reinstall deps, re-copy env files) |
| **List**                    | Quick-pick list of all active trees                                 |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR creation and merge)

## Setup

Add `.forest/config.json` to your repo root (tip: ask Claude to generate one for your project):

```json
{
  "version": 1,
  "copy": [".env", ".env.local"],
  "setup": "bun install --frozen-lockfile",
  "shortcuts": [
    { "name": "dev", "type": "terminal", "command": "bunx turbo dev", "openOnLaunch": 1 },
    { "name": "claude", "type": "terminal", "command": "claude", "openOnLaunch": 1, "mode": "multiple" },
    { "name": "shell", "type": "terminal", "mode": "multiple" },
    { "name": "App", "type": "browser", "url": "http://localhost:3000", "openOnLaunch": 2 }
  ],
  "linear": {
    "enabled": true,
    "teams": ["ENG"],
    "statuses": {
      "issueList": ["triage", "backlog", "unstarted"],
      "onNew": "started",
      "onShip": "in review",
      "onCleanup": "completed"
    }
  },
  "github": { "enabled": true },
  "branchFormat": "${ticketId}-${slug}",
  "baseBranch": "origin/main",
  "maxTrees": 10
}
```

Per-developer overrides go in `.forest/local.json` (should be gitignored):

```json
{
  "linear": {
    "apiKey": "lin_api_YOUR_KEY"
  },
  "browser": "external"
}
```

## Generating Config with AI

To set up Forest, ask Claude (or any AI) to read this README and generate `.forest/config.json`. The AI should inspect the repo and ask you:

1. **Setup command?** → detect from lockfile: `bun install`, `npm install`, `yarn`, `pnpm install`
3. **Files to copy into trees?** → check which of `.env`, `.env.local`, `.envrc` exist
4. **Shortcuts?** → what terminals to open (dev server, claude, shell), any browser URLs
5. **Linear integration?** → yes/no, and team key(s) (e.g. `["ENG"]` or `["ENG", "UX"]`)

### Config reference

| Field          | Required | Default               | Description                                                                                                                                                                                                                                                                                                               |
| -------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | —                     | Always `1`                                                                                                                                                                                                                                                                                                                |
| `setup`        | no       | —                     | Command(s) to run after creating a tree                                                                                                                                                                                                                                                                                   |
| `copy`         | no       | `[]`                  | Files to copy from repo root into each tree                                                                                                                                                                                                                                                                               |
| `shortcuts`    | no       | `[]`                  | Terminals, browsers, files to open per tree                                                                                                                                                                                                                                                                               |
| `linear`       | no       | `{ enabled: false }`  | Linear integration. Auto-enabled when `apiKey` is set. `teams` is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`). `statuses` controls issue list and lifecycle transitions including `onCancel` (**must use lowercase** state names: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`) |
| `github`       | no       | `{ enabled: true }`   | GitHub integration toggle                                                                                                                                                                                                                                                                                                 |
| `branchFormat` | no       | `${ticketId}-${slug}` | Branch naming. Supports `${ticketId}`, `${slug}`                                                                                                                                                                                                                                                                          |
| `baseBranch`   | no       | `origin/main`         | Branch to rebase on                                                                                                                                                                                                                                                                                                       |
| `maxTrees`     | no       | `10`                  | Max concurrent worktrees                                                                                                                                                                                                                                                                                                  |
| `browser`      | no       | `simple`              | Default browser for `browser` shortcuts: `simple` (VS Code Simple Browser), `external` (system default), or an app name (e.g. `"Firefox"`)                                                                                                                                                                               |

**Shortcut types:** `terminal` (with optional `command`, `env`, `mode`), `browser` (with `url`, optional `browser`), `file` (with `path`). All support `openOnLaunch: N` (priority order, `false` to disable). Terminal `mode`: `single-tree` (default, one instance per tree), `single-repo` (kills previous on reopen), `multiple` (new instance each click, no stop/restart buttons). Browser shortcuts accept a per-shortcut `browser` override (same values as the top-level `browser` setting).

**Variable expansion in shortcuts:** `${ticketId}`, `${branch}`, `${slug}`, `${repo}`, `${treePath}`, `${prNumber}`, `${prUrl}`.

**`local.json`** (gitignored) merges over `config.json` — use for per-dev AI keys and overrides.

## Features

### Tree Grouping

The Trees sidebar groups trees by status:

- **In Progress** — no PR created yet
- **In Review** — PR is open
- **Done** — PR has been merged

### Tree Health Indicators

Each tree shows live health info:

```
ENG-1234  Fix login bug   3↓ · 2h
ENG-5678  Add dark mode   PR approved · 1d
```

- **N↓** — commits behind base branch
- **Age** — time since last commit
- **PR status** — open, approved, changes requested

### Auto-Cleanup on Merged PRs

Trees with a PR are polled every 5 minutes. When a PR is merged, you get a notification: *"ENG-1234 PR was merged. Clean up?"* → click Cleanup to remove the worktree automatically.

### Update (Rebase + Refresh)

`Update` fetches and rebases your tree on the base branch before copying config files and running setup. If the rebase fails, it auto-aborts and shows an error.

### Shortcut Variable Expansion

Shortcuts support these variables in commands, URLs, and file paths:

| Variable      | Description                       | Example value                             |
| ------------- | --------------------------------- | ----------------------------------------- |
| `${ticketId}` | Linear ticket ID                  | `ENG-123`                                 |
| `${branch}`   | Full branch name                  | `ENG-123-fix-login`                       |
| `${slug}`     | Branch name without ticket prefix | `fix-login`                               |
| `${repo}`     | Repository name                   | `my-app`                                  |
| `${treePath}` | Absolute path to the worktree     | `/Users/you/.forest/trees/my-app/ENG-123` |
| `${prNumber}` | PR number (after ship)            | `42`                                      |
| `${prUrl}`    | PR URL (after ship)               | `https://github.com/org/repo/pull/42`     |

```json
{ "name": "Linear", "type": "browser", "url": "https://linear.app/team/issue/${ticketId}" },
{ "name": "PR", "type": "browser", "url": "${prUrl}" },
{ "name": "logs", "type": "terminal", "command": "tail -f ${treePath}/logs/dev.log" }
```

### Streaming Setup Output

Setup commands stream their output in real-time to the **Forest** output channel, so you can watch `npm install` progress instead of staring at a spinner.

### Browser Wait-for-Port

Browser shortcuts targeting `localhost` automatically wait up to 2 minutes for the port to open before launching, with a progress notification. No more refreshing a blank page while the dev server starts.

### Pre-Warm Template

After the first tree runs setup, `node_modules` is saved as a template. Subsequent trees get an instant copy (APFS clonefile on macOS, hardlinks on Linux) before running setup, dramatically speeding up tree creation.

### Direnv Support

If a `.envrc` file exists in the tree, Forest automatically runs `direnv allow` during setup.

Rebuild the template manually: `Forest: Warm Template` from the command palette.

### Claude Code Trust

Claude Code asks for trust confirmation when opening a new workspace. Since each tree creates a new directory, you'd get this prompt for every tree. To avoid it, add `~/.forest/trees` to Claude's trusted directories:

In `~/.claude/settings.json`:
```json
{
  "trustedDirectories": ["/Users/you/.forest/trees"]
}
```

Replace `/Users/you` with your actual home directory.

### Configurable Linear Statuses

Customize which Linear states to show in the issues sidebar and which states to set on new/ship/cleanup.

Status names in `issueList` use Linear's built-in types: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. Status names in `onShip`, `onNew`, etc. can be custom workflow state names (e.g. `"in review"`) — Forest resolves them via the Linear API. Use team **keys** (e.g. `ENG`), not display names. Multiple teams are supported.

```json
"linear": {
  "enabled": true,
  "teams": ["ENG"],
  "statuses": {
    "issueList": ["triage", "backlog", "unstarted"],
    "onNew": "started",
    "onShip": "in review",
    "onCleanup": "completed",
    "onCancel": "canceled"
  }
}
```

## Usage

All commands are available from the Forest sidebar (tree icon in activity bar) or the command palette (`Cmd+Shift+P` → "Forest: ...").

**Typical workflow:**

1. **New Tree** from a Linear ticket (or **New Linear Issue + Tree** to create a new ticket)
2. A new VSCode window opens with terminals running
3. Code, test, iterate — each tree is fully isolated
4. **Ship** when ready — pushes and creates a PR
5. **Cleanup** after merge — removes worktree, branch, and ticket
6. **Cancel** to discard a tree without merging

Switch between trees from the sidebar. All processes keep running in background windows.

## Commands

| Command                           | Description                             |
| --------------------------------- | --------------------------------------- |
| `Forest: New Linear Issue + Tree` | Create new ticket + tree                |
| `Forest: New Tree`                | Tree from existing ticket               |
| `Forest: Switch Tree`             | Open another tree's window              |
| `Forest: Ship`                    | Push + create PR                        |
| `Forest: Cleanup`                 | Merge PR + remove tree                  |
| `Forest: Cancel`                  | Remove tree without merging             |
| `Forest: Update`                  | Rebase + refresh deps                   |
| `Forest: List`                    | List all trees                          |
| `Forest: Copy Branch Name`        | Copy current tree's branch to clipboard |
| `Forest: Open PR`                 | Open PR in browser                      |
| `Forest: Copy Setup Prompt`       | Copy AI setup prompt to clipboard       |
| `Forest: Warm Template`           | Rebuild node_modules template           |

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
