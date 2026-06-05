# Forest

![Forest](forest.png)

VSCode extension for parallel feature development using git worktrees. One Linear ticket = one branch = one worktree = one VSCode window.

[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vladstudio.vladstudio-forest)

| Command         | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **New Tree**    | Unified wizard: pick new or existing branch, optionally link a Linear ticket                      |
| **Ship**        | Push branch + create PR (with optional automerge) + move ticket to configured status              |
| **Cleanup**     | Auto-triggered when PR is merged: remove worktree + branches + move ticket to configured status   |
| **Delete Tree** | Interactive form: choose branch cleanup (keep / local only / all), Linear status, and PR handling |
| **Update**      | Merge from the base branch + re-copy env files                                                    |
| **List**        | Quick-pick list of all active trees                                                               |

## Prerequisites

- `git` (required)
- `gh` CLI (for PR creation and merge, unless you disable GitHub integration)

## Setup

Add `.forest/config.json` to your repo root (tip: ask Claude to generate one for your project):

```json
{
  "version": 1,
  "copy": [".env", ".env.local"],
  "symlink": ["node_modules"],
  "shortcuts": {
    "cli": [
      { "name": "install", "command": "bun install --frozen-lockfile", "onNewTree": true },
      { "name": "dev", "command": "bunx turbo dev" },
      { "name": "claude", "command": "claude" },
      { "name": "shell" }
    ],
    "web": [
      { "name": "App", "url": "http://localhost:3000" }
    ]
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
3. **Linear integration?** → yes/no, and team key(s) (e.g. `["ENG", "UX"]`). Get your API key from [Linear account security](https://linear.app/settings/account/security)

### Config reference

| Field          | Required | Default                    | Description                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | —                          | Always `1`                                                                                                                                                                                                                                                                                                                                                                                      |
| `copy`         | no       | `[]`                       | Files to copy from repo root into each tree                                                                                                                                                                                                                                                                                                                                                     |
| `symlink`      | no       | `[]`                       | Directories to symlink from the main repo into each tree (e.g. `["node_modules"]`). Symlinks are relative, created after copy, and cleaned up before worktree removal.                                                                                                                                                                                                                          |
| `shortcuts`    | no       | `{cli:[],web:[]}`          | Terminals (`cli`) and browsers (`web`) to open per tree. Each array holds objects with `name` and type-specific fields.                                                                                                                                                                                                                                                                         |
| `linear`       | no       | disabled                   | Linear integration. Auto-enabled when `teams` or `apiKey` is set. `teams` is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`). `issueList` must use Linear's built-in lowercase state types (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`). `onNew`, `onShip`, `onCleanup`, and `onCancel` can be state names or types and are matched case-insensitively. |
| `github`       | no       | `true`                     | GitHub integration toggle. Set `false` to disable                                                                                                                                                                                                                                                                                                                                               |
| `branchFormat` | no       | `${ticketId}-${slug}`      | Branch naming for Linear-linked trees. Supports `${ticketId}`, `${slug}`                                                                                                                                                                                                                                                                                                                        |
| `branchNamePrefix` | no   | `""`                     | Prefill for manual new branches. Supports `{YYMMDD}`, `{YY}`, `{MM}`, `{DD}`                                                                                                                                                                                                                                                                                                                    |
| `baseBranch`   | no       | `main`                     | Base branch name (`origin/` prefix is added automatically)                                                                                                                                                                                                                                                                                                                                      |
| `maxTrees`     | no       | `10`                       | Max concurrent worktrees                                                                                                                                                                                                                                                                                                                                                                        |
| `ai`           | no       | `false`                    | AI-generated commit messages and PR descriptions using Tetra. Set `true` to enable. Requires Tetra to be running with AI commands configured (see below).                                                                                                                                                                                                                                       |
| `browser`      | no       | `["integrated"]`           | Browser app list. First item is the default; right-click a shortcut to pick another. Values: `integrated` (VS Code integrated browser), `external` (system default), or an app name (e.g. `"Firefox"`)                                                                                                                                                                                          |
| `terminal`     | no       | `["integrated"]`           | Terminal app list. First item is the default; right-click to pick another. Values: `integrated` (VS Code terminal), or an external app (`iTerm`, `Terminal`, `Ghostty`). External terminals receive the shortcut command automatically                                                                                                                                                          |

Shortcuts support `onNewTree: true` to auto-open when a tree is first created (e.g. for dependency installation). Terminal shortcuts also accept `command` and `env`. Browser shortcuts accept a per-shortcut `browser` override (same values as the top-level `browser` setting). Terminal and browser shortcuts show an external-open button on hover. The terminal button opens the system Terminal app; the browser button opens the system default browser. Shortcut values are treated literally: Forest does not expand `${...}` placeholders inside shortcut commands, URLs, or env vars.

**`local.json`** (gitignored) merges over `config.json` — use for per-dev overrides.

## Features

### Tree Grouping

- **Deleting** — cleanup in progress (loading spinner)
- **In progress** — no PR created yet
- **In review** — PR is open
- **Done** — PR has been merged
- **Closed** — PR has been closed

### Tree Card Indicators

On the active tree card, Forest surfaces:

- `Pull N` for commits behind the remote branch
- `Main N` for commits behind the configured base branch
- `+N / -N / ~N` for working tree changes
- `PR#N` when a pull request exists

### Auto-Cleanup on Merged PRs

When a PR is merged, Forest shows a cleanup notification. Choosing Cleanup removes the worktree, deletes the branch, updates the Linear ticket if enabled, and closes the tree window when appropriate.

### Update / Rebase

`Update` merges your tree from the configured base branch and re-copies config files. `Rebase` does the same with `git rebase` instead of merge. If either operation fails, Forest shows an error and leaves conflicts for you to resolve manually.

### Direnv Support

If a `.envrc` file exists in the tree, Forest automatically runs `direnv allow` during tree creation and when switching into that tree.

### Dev Containers

If your repo has `.devcontainer/devcontainer.json`, the New Tree form shows a **Sandbox / Direct** toggle. Sandboxed trees open via the Dev Containers extension; Forest itself stays host-side, so all sidebar actions (Ship, Cleanup, Update, etc.) keep working from the container window. Cleanup removes the tree's containers and anonymous volumes (requires Docker).

Git is intentionally not exposed inside the container — commit and push via the Forest sidebar or a host terminal, not from a container terminal.

### AI Integration

Forest uses **Tetra** for AI-generated commit messages and PR descriptions. To enable:

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

Most user-facing actions are available from the Forest sidebar (tree icon in activity bar) or the command palette (`Cmd+Shift+P` → "Forest: ...").

**Typical workflow:**

1. **New Tree** from a Linear ticket, or create a new Linear issue in the form
2. A new VS Code window opens, then any configured `onNewTree` shortcuts run
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
| `Forest: Ship + Automerge`   | Push + create PR + enable automerge when supported      |
| `Forest: Delete Tree`        | Interactive deletion with branch/ticket/PR options      |
| `Forest: Update`             | Merge from the base branch + re-copy config files       |
| `Forest: Rebase`             | Rebase onto the base branch                             |
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
"git.openRepositoryInParentFolders": "always", // git works in worktree subdirs
"terminal.integrated.gpuAcceleration": "canvas" // avoids a bug with heavy parallel terminal output
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
code --install-extension vladstudio-forest-*.vsix
```

## Development

```bash
bun install
# Press F5 in VSCode to launch Extension Development Host
```
