# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
bun run compile        # Type-check + esbuild bundle
bun run watch          # Concurrent tsc + esbuild watch mode
bun run package        # Production build (minified, no sourcemaps)
bun run check-types    # TypeScript type-check only (tsc --noEmit)
bun run lint           # ESLint on src/
```

Press F5 in VS Code to launch the Extension Development Host for testing.

Output: `dist/extension.js` (single bundle, `vscode` marked as external).

## Architecture

**Entry point**: `src/extension.ts` — loads config, creates managers/providers, registers commands, sets up state watching across windows.

**Key flow**: Config → StateManager → Managers → Providers → VS Code UI.

### Config (`src/config.ts`)
Three-tier merge: defaults → `.forest/config.json` (repo) → `.forest/local.json` (gitignored per-dev). `copy` copies files into each tree; `symlink` creates relative symlinks from the tree to the main repo for large directories (e.g. `node_modules`). Symlinks are created in `symlinkConfigDirs()`, cleaned up before worktree removal in cleanup.ts, and re-applied during update/rebase. Shortcuts merge by `name` field; categories are `cli` and `web` only. Shortcuts support `onNewTree: true` to auto-open when a tree is first created. Terminal shortcuts accept `command` and `env`; browser shortcuts accept a per-shortcut `browser` override. Terminal/browser items expose an inline external-open action. The terminal action opens the system Terminal app. Shortcut values are literal; Forest does not expand `${...}` placeholders in shortcut commands, URLs, or env vars. `baseBranch` stored without `origin/` prefix; callers prepend when needed. `linear` auto-enabled when `teams` or `apiKey` present. `github` accepts boolean shorthand. Top-level `browser` setting is a `string[]` (first item is default, right-click picks from list); values: `integrated` | `external` | app name. Per-shortcut `browser` field overrides it. Top-level `terminal` is also `string[]`; values: `integrated` | app name (`iTerm`, `Terminal`, `Ghostty`). Both accept a single string for backward compatibility.

### State (`src/state.ts`)
Global state at `~/.forest/state.json`. Trees keyed as `repoPath:branch`. File-watch-based cross-window coordination with debounced events (self-writes suppressed). Atomic writes via temp+rename, backed by an in-memory cache (`cachedState`). Writes are serialized by an in-process queue **and** a cross-process mkdir file lock (`state.json.lock/`) with stale detection (dead-holder via `kill(pid,0)` or lock older than 10s). Corrupt state is backed up as `.corrupt-*` and reset. Long-running tree ops set a `busyOperation` + heartbeat (`busyHeartbeatAt`, stale after 45s) so other windows show "already shipping/pulling/…".

### Context (`src/context.ts`)
`ForestContext` is a dependency container passed to all commands — no globals. Contains config, all managers, providers, and current tree.

### Commands (`src/commands/`)
Command files are thin UI wrappers around orchestration in `commands/shared.ts` (the largest module). `createTree()` orchestrates: worktree creation → state save (deferred until the worktree succeeds, rolled back on failure) → carry-changes apply → copy files + symlinks → `direnv allow` → open window. Mutating ops run under `withTreeOperation()` (sets the busy-operation heartbeat; see State). Shortcuts with `onNewTree` run in the new window via the `needsSetup` flag on `TreeState`.

### Managers (`src/managers/`)
- **ShortcutManager**: Terminal/browser open lifecycle (terminals are created via `vscode.window.createTerminal` and not retained). `openWith()` shows a QuickPick from the configured app list. Integrated terminals are spawned on the workspace folder URI (so they land on the correct side — host or inside a dev container). External terminals via AppleScript (iTerm, Terminal.app) or spawn (Ghostty); unsupported apps open at cwd without the command. Browsers: `integrated` (simpleBrowser), `external` (system default), or a custom app (`open -a <app>`).
- **StatusBarManager**: Shows current tree info in status bar.

### Views (`src/views/`)
- `ForestWebviewProvider` renders the main sidebar (tree cards) as a webview; also hosts sidebar actions (new-tree wizard, ship, delete, AI commit message).
- `ShortcutsTreeProvider` — standard `TreeDataProvider` for the shortcuts panel.
- `TodosTreeProvider` — `TreeDataProvider` listing your assigned Linear issues in `issueList` states; clicking creates a tree from the issue.
- `treeData.ts` — `TreeDataService` builds per-tree card data (PR state/number, commits behind base + behind remote, local change counts) with a 30s TTL cache. Defines card grouping (In progress / In review / Done / Closed / Deleting) and `treeKey()`/`parseTreeKey()` for webview↔state correlation.

### CLI Wrappers (`src/cli/`)
- `git.ts`, `linear.ts`, `gh.ts` — thin exec wrappers. Tool availability cached once per session; calls degrade gracefully when tools are missing / auth is expired. `gh.ts` also has `repoHasAutomerge()` (cached) + `enableAutomerge()` for the ship-automerge flow, `createPR()` (PR body via a temp `--body-file`, else `--fill`), and `closePR()`.
- `ai.ts` — calls **Tetra** (local menu-bar app, default `http://localhost:24100/transform`) for `generateCommitMessage()` (sidebar commit action) and `generatePRBody()` (ship). Opt-in via the `tetra` config block (presence enables AI; `port` and `commands.commit`/`commands.pr` are resolved against defaults in `config.ts`); `ship` falls back to `gh pr create --fill` on failure.
- `devcontainer.ts` — Docker cleanup for sandboxed (dev container) trees: `cleanup()` stops/removes containers + anonymous volumes labeled `devcontainer.local_folder=<path>`.

### Logging & Notifications
There is no file logger — diagnostics go to the Forest **OutputChannel** (`ctx.outputChannel.appendLine("[Forest] …")`), surfaced on step failures via `runStep()` in `commands/shared.ts`. User-facing feedback uses `src/notify.ts`: `notify.info`/`warn` are auto-dismissing progress notifications; `notify.error` is a real error dialog.

### Utilities (`src/utils/`)
- `exec.ts`: `exec()` (safe `execFile`, no shell) for CLI tools, `execShell()` (shell) for user commands, `commandExists()` (cross-platform `which`/`where`). All have timeouts and a 10 MB max buffer.
- `slug.ts`: `formatBranch()` expands `branchFormat` (`${ticketId}`/`${slug}`), `formatBranchPrefix()` expands date tokens (`{YYMMDD}`/`{YY}`/`{MM}`/`{DD}`), `sanitizeBranch()` cleans branch input, `shellEscape()` for safe shell interpolation.
- `fs.ts`: `repoHash()` (8-char md5) to disambiguate repos sharing a basename, `safeRelativePath()` path-escape guard for `copy`/`symlink`, `tryUnlinkSync()`.

## Conventions

- Package.json `contributes.menus` uses `contextValue` from TreeItems for `when` clauses — keep these in sync when adding menu items.
- Linear CLI states must be **lowercase** (`started`, not `Started`).
- Linear config lives under `linear: { teams, statuses }`. Enabled is inferred from `teams` or `apiKey`. The `teams` value is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`), not display names.
