<p align="center">
  <img src="forest.png" width="128" alt="Forest">
</p>

# Forest

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vladstudio.vladstudio-forest)

| --------------- | ------------------------------------------------------------------------------------------------- |
| **New Tree**    | Unified wizard: pick new or existing branch, optionally link a Linear ticket                      |
| **Ship**        | Push branch + create PR (with optional automerge) + move ticket to configured status              |
| **Cleanup**     | Auto-triggered when PR is merged: remove worktree + branches + move ticket to configured status   |
| **Delete Tree** | Interactive form: choose branch cleanup (keep / local only / all), Linear status, and PR handling |
| **Update**      | Merge from main + re-copy env files                                                               |
| **List**        | Quick-pick list of all active trees                                                               |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR creation and merge)

## Setup

Add `.forest/config.json` to your repo root (tip: ask Claude to generate one for your project):

```json
{
  "version": 1,
  "copy": [".env", ".env.local"],
  "shortcuts": {
    "cli": [
      { "name": "install", "command": "bun install --frozen-lockfile", "onNewTree": true },
      { "name": "dev", "command": "bunx turbo dev" },
      { "name": "claude", "command": "claude" },
      { "name": "shell" }
    ],
    "web": [
      { "name": "App", "url": "http://localhost:3000" }
    ],
    "files": []
  },
  "linear": {
    "teams": ["ENG"],
    "statuses": {
      "issueList": ["triage", "backlog", "unstarted", "started"],
      "onNew": "started",
      "onShip": "in review",
      "onCleanup": "completed"
    }
  }
}
```

Per-developer overrides go in `.forest/local.json` (should be gitignored):

```json
{
  "linear": {
    "apiKey": "lin_api_YOUR_KEY"
  },
  "browser": ["external", "Firefox"],
  "terminal": ["iTerm", "integrated"]
}
```

## Generating Config with AI

To set up Forest, ask Claude (or any AI) to read this README and generate `.forest/config.json`. The AI should inspect the repo and ask you:

1. **Files to copy into trees?** → check which of `.env`, `.env.local`, `.envrc` exist
2. **Shortcuts?** → what terminals to open (dev server, claude, shell), any browser URLs, any one-time setup commands (e.g. `bun install` with `onNewTree: true`)
3. **Linear integration?** → yes/no, and team key(s) (e.g. `["ENG", "UX"]`). Get your API key from https://linear.app/settings/account/security

### Config reference

| Field          | Required | Default               | Description                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`      | yes      | —                     | Always `1`                                                                                                                                                                                                                                                                                                                           |
| `copy`         | no       | `[]`                  | Files to copy from repo root into each tree                                                                                                                                                                                                                                                                                          |
| `shortcuts`    | no       | `{cli:[],web:[],files:[]}` | Terminals (`cli`), browsers (`web`), and files (`files`) to open per tree. Each array holds objects with `name` and type-specific fields.                                                                                                                                                                                     |
| `linear`       | no       | disabled              | Linear integration. Auto-enabled when `teams` or `apiKey` is set. `teams` is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`). `statuses` controls issue list and lifecycle transitions including `onCancel` (**must use lowercase** state names: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`) |
| `github`       | no       | `true`                | GitHub integration toggle. Set `false` to disable                                                                                                                                                                                                                                                                                    |
| `branchFormat` | no       | `${ticketId}-${slug}` | Branch naming. Supports `${ticketId}`, `${slug}`                                                                                                                                                                                                                                                                                     |
| `baseBranch`   | no       | `main`                | Base branch name (`origin/` prefix is added automatically)                                                                                                                                                                                                                                                                           |
| `maxTrees`     | no       | `10`                  | Max concurrent worktrees                                                                                                                                                                                                                                                                                                             |
| `ai`           | no       | `false`               | AI-generated PR descriptions using Tetra. Set `true` to enable. Requires Tetra to be running with AI commands configured (see below).                                                                                                                                                                                                 |
| `logging`      | no       | `true`                | File-based logging to `~/.forest/forest.log`. Rotates at 5 MB                                                                                                                                                                                                                                                                        |
| `browser`      | no       | `["integrated"]`      | Browser app list. First item is the default; right-click a shortcut to pick another. Values: `integrated` (VS Code integrated browser), `external` (system default), or an app name (e.g. `"Firefox"`)                                                                                                                               |
| `terminal`     | no       | `["integrated"]`      | Terminal app list. First item is the default; right-click to pick another. Values: `integrated` (VS Code terminal), or an external app (`iTerm`, `Terminal`, `Ghostty`). External terminals receive the shortcut command automatically                                                                                               |

Shortcuts support `onNewTree: true` to auto-open when a tree is first created (e.g. for dependency installation). Terminals also accept `command` and `env`. Browser shortcuts accept a per-shortcut `browser` override (same values as the top-level `browser` setting). Shortcut values are treated literally: Forest does not expand `${...}` placeholders inside shortcut commands, URLs, env vars, or file paths.

**`local.json`** (gitignored) merges over `config.json` — use for per-dev overrides.

## Features

### Tree Grouping

- **Cleaning up** — cleanup in progress (loading spinner)
- **In Progress** — no PR created yet
- **In Review** — PR is open
- **Done** — PR has been merged
- **Closed** — PR has been closed

### Tree Health Indicators

```
ENG-1234  Fix login bug   3↓ · 2h
ENG-5678  Add dark mode   PR approved · 1d
```

- **N↓** — commits behind base branch
- **Age** — time since last commit
- **PR status** — open, approved, changes requested

### Auto-Cleanup on Merged PRs

When a PR is merged, you get a notification: *"ENG-1234 PR was merged. Clean up?"* → click Cleanup to remove the worktree automatically.

### Update (Rebase + Refresh)

`Update` fetches and merges (or rebases) your tree on the base branch and re-copies config files. If the merge/rebase fails, it shows an error.

### Direnv Support

If a `.envrc` file exists in the tree, Forest automatically runs `direnv allow` during tree creation.

### Dev Containers

If your repo has `.devcontainer/devcontainer.json`, the New Tree form shows a **Sandbox / Direct** toggle. Sandboxed trees open via the Dev Containers extension; Forest itself stays host-side, so all sidebar actions (Ship, Cleanup, Update, etc.) keep working from the container window. Cleanup removes the tree's containers and anonymous volumes (requires Docker).

Git is intentionally not exposed inside the container — commit and push via the Forest sidebar or a host terminal, not from a container terminal.

### AI Integration

Forest uses **Tetra** for AI-generated PR descriptions. To enable:

1. Install [Tetra](https://apps.vlad.studio/tetra) (a macOS menu bar app)
2. Add Tetra commands to `~/.config/tetra/commands/`:
   - `AI Generate commit message.prompt.md` — generates commit messages
   - `AI Generate PR description.prompt.md` — generates PR descriptions
3. Set `"ai": true` in your `.forest/config.json`

Example Tetra command (`~/.config/tetra/commands/AI Generate PR description.prompt.md`):

```markdown
---
llm: cerebras_qwen
temperature: 0.2
---

Write a concise pull request description for the following diff. Use markdown. Start with a short summary paragraph, then a bullet list of key changes if needed. Do not include a title. Keep the total response under 500 words.

PR title: {{title}}

Diff:
{{text}}

OUTPUT ONLY THE PR DESCRIPTION.
```

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
  "teams": ["ENG"],
  "statuses": {
    "issueList": ["backlog", "unstarted"],
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
4. **Ship** when ready — pushes and creates a PR (with AI-generated description if enabled)
5. **Cleanup** after merge — removes worktree, branch, and ticket
6. **Delete** to remove a tree (keep branches, delete local only, or delete all)

Switch between trees from the sidebar. All processes keep running in background windows.

## Commands

| Command                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `Forest: New Tree`           | Create tree (unified wizard)                            |
| `Forest: Switch Tree`        | Open another tree's window                              |
| `Forest: Ship`               | Push + create PR (offers automerge if repo supports it) |
| `Forest: Delete Tree`        | Interactive deletion with branch/ticket/PR options      |
| `Forest: Update`             | Merge from main + re-copy config files                  |
| `Forest: Rebase`             | Rebase onto main                                        |
| `Forest: Pull`               | Pull latest changes                                     |
| `Forest: Push`               | Push to remote                                          |
| `Forest: List`               | List all trees                                          |
| `Forest: Open Main`          | Open main repo window                                   |
| `Forest: View Pull Request`  | Open PR in browser                                      |
| `Forest: View Linear Ticket` | Open Linear ticket in browser                           |
| `Forest: Reveal in Finder`   | Open worktree directory in Finder                       |
| `Forest: Copy Branch Name`   | Copy current tree's branch to clipboard                 |
| `Forest: Copy Setup Prompt`  | Copy AI setup prompt to clipboard                       |

## Recommended VS Code Settings

```json
"window.nativeTabs": true,
"window.titleBarStyle": "native",
"window.customTitleBarVisibility": "never",
"window.title": "${rootName}",                // readable tab labels per worktree
"window.restoreWindows": "preserve",          // survives restarts
"window.closeWhenEmpty": true,
"git.openRepositoryInParentFolders": "always" // git works in worktree subdirs
```

To open terminals as editor tabs (instead of the bottom panel), add this keybinding (`Cmd+T`):

```json
{
  "key": "cmd+t",
  "command": "workbench.action.createTerminalEditor"
}
```

To use Shift+Enter for new lines inside terminal, add this keybinding:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": {
    "text": "\u001b[13;2u"
  },
  "when": "terminalFocus"
}
```

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
