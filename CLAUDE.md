# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
bun run compile        # Type-check + esbuild bundle
bun run watch          # Concurrent tsc + esbuild watch mode
bun run package        # Production build (minified, no sourcemaps)
bun run check-types    # TypeScript type-check only (tsc --noEmit)
```

Press F5 in VS Code to launch the Extension Development Host for testing.

Output: `dist/extension.js` (single bundle, `vscode` marked as external).

## Architecture

**Entry point**: `src/extension.ts` — loads config, creates managers/providers, registers commands, sets up state watching across windows.

**Key flow**: Config → StateManager → Managers → TreeDataProviders → VS Code UI.

### Config (`src/config.ts`)
Three-tier merge: defaults → `.forest/config.json` (repo) → `.forest/local.json` (gitignored per-dev). Shortcuts merge by `name` field; type is inferred from fields (`url` → browser, `path` → file, else terminal). `baseBranch` stored without `origin/` prefix (auto-prepended). `linear` auto-enabled when `teams` or `apiKey` present. `github` accepts boolean shorthand. Supports `${repo}`, `${ticketId}`, `${branch}`, `${slug}`, `${treePath}`, `${prNumber}`, `${prUrl}` variable expansion. Top-level `browser` setting (`simple` | `external` | app name) controls where browser shortcuts open; per-shortcut `browser` field overrides it.

### State (`src/state.ts`)
Global state at `~/.forest/state.json`. Trees keyed as `repoPath:ticketId`. File-watch-based cross-window coordination with debounced events. Atomic writes via temp+rename. Write-locked to prevent races.

### Context (`src/context.ts`)
`ForestContext` is a dependency container passed to all commands — no globals. Contains config, all managers, providers, and current tree.

### Commands (`src/commands/`)
Thin wrappers (40-60 lines) around shared logic in `commands/shared.ts`. `createTree()` orchestrates: port allocation → worktree creation → file copy → setup → state save → open window.

### Managers (`src/managers/`)
- **ShortcutManager**: Terminal/browser/file lifecycle. Tracks terminals in `Map<string, vscode.Terminal[]>`. Emits change events for UI. Supports `mode` (`single-tree`, `single-repo`, `multiple`) for terminal instance control.
- **StatusBarManager**: Shows current tree info in status bar.

### Views (`src/views/`)
Standard `TreeDataProvider` pattern. `items.ts` defines all TreeItem subclasses with `contextValue` for context menus. Health metrics (commits behind, PR status, age) cached 30 seconds in `TreesTreeProvider`.

### CLI Wrappers (`src/cli/`)
`git.ts`, `linear.ts`, `gh.ts` — thin exec wrappers. Tool availability cached once per session. All calls wrapped in try/catch for graceful degradation when tools are missing.

### Execution (`src/utils/exec.ts`)
Three patterns: `exec()` (safe execFile), `execShell()` (user commands), `execStream()` (long-running with output channel streaming). All have timeouts and max buffer limits.

## Conventions

- Package.json `contributes.menus` uses `contextValue` from TreeItems for `when` clauses — keep these in sync when adding menu items.
- Linear CLI states must be **lowercase** (`started`, not `Started`).
- Linear config lives under `linear: { teams, statuses }`. Enabled is inferred from `teams` or `apiKey`. The `teams` value is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`), not display names.
