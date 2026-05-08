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
Three-tier merge: defaults → `.forest/config.json` (repo) → `.forest/local.json` (gitignored per-dev). `copy` copies files into each tree; `symlink` creates relative symlinks from the tree to the main repo for large directories (e.g. `node_modules`). Symlinks are created in `symlinkConfigDirs()`, cleaned up before worktree removal in cleanup.ts, and re-applied during update/rebase. Shortcuts merge by `name` field; type is inferred from fields (`url` → browser, `path` → file, else terminal). Shortcuts support `onNewTree: true` to auto-open when a tree is first created. Shortcut values are literal; Forest does not expand `${...}` placeholders in shortcut commands, URLs, env vars, or file paths. `baseBranch` stored without `origin/` prefix; callers prepend when needed. `linear` auto-enabled when `teams` or `apiKey` present. `github` accepts boolean shorthand. Top-level `browser` setting is a `string[]` (first item is default, right-click picks from list); values: `integrated` | `external` | app name. Per-shortcut `browser` field overrides it. Top-level `terminal` is also `string[]`; values: `integrated` | app name (`iTerm`, `Terminal`, `Ghostty`). Both accept a single string for backward compatibility.

### State (`src/state.ts`)
Global state at `~/.forest/state.json`. Trees keyed as `repoPath:branch`. File-watch-based cross-window coordination with debounced events. Atomic writes via temp+rename. Write-locked to prevent races.

### Context (`src/context.ts`)
`ForestContext` is a dependency container passed to all commands — no globals. Contains config, all managers, providers, and current tree.

### Commands (`src/commands/`)
Thin wrappers (40-60 lines) around shared logic in `commands/shared.ts`. `createTree()` orchestrates: worktree creation → file copy → direnv → state save → open window. Shortcuts with `onNewTree` run in the new window via `needsSetup` flag on `TreeState`.

### Managers (`src/managers/`)
- **ShortcutManager**: Terminal/browser/file lifecycle. Tracks terminals in `Map<string, vscode.Terminal[]>`. Emits change events for UI. `openWith()` shows a QuickPick to choose from the configured app list. External terminal support for iTerm, Terminal.app, and Ghostty via AppleScript.
- **StatusBarManager**: Shows current tree info in status bar.

### Views (`src/views/`)
`ForestWebviewProvider` renders the main tree sidebar as a webview. `ShortcutsTreeProvider` is a standard `TreeDataProvider` for the shortcuts panel. Health metrics (commits behind, PR status, age) cached 30 seconds.

### CLI Wrappers (`src/cli/`)
`git.ts`, `linear.ts`, `gh.ts` — thin exec wrappers. Tool availability cached once per session. All calls wrapped in try/catch for graceful degradation when tools are missing. `gh.ts` also has `repoHasAutomerge()` (cached) and `enableAutomerge()` for the ship automerge flow. `ai.ts` — raw `fetch` calls to AI providers (anthropic, openai, gemini) for PR body generation; used by `ship` when `config.ai` is set, falls back to `--fill` on failure.

### Logging (`src/logger.ts`)
File-based logging to `~/.forest/forest.log`. Rotation at 5 MB. Levels: INFO, WARN, ERROR. Lazy init via `initLogger()` (only when `config.logging` is true).

### Utilities (`src/utils/`)
- `exec.ts`: Two execution patterns: `exec()` (safe execFile), `execShell()` (user commands). Both have timeouts and max buffer limits.
- `slug.ts`: `slugify()` for branch name generation, `shellEscape()` for safe shell interpolation.
- `fs.ts`: `repoHash()` for disambiguating repos with the same basename, `tryUnlinkSync()` for safe file deletion.

## Conventions

- Package.json `contributes.menus` uses `contextValue` from TreeItems for `when` clauses — keep these in sync when adding menu items.
- Linear CLI states must be **lowercase** (`started`, not `Started`).
- Linear config lives under `linear: { teams, statuses }`. Enabled is inferred from `teams` or `apiKey`. The `teams` value is an array of team **keys** (e.g. `["ENG"]` or `["ENG", "UX"]`), not display names.
