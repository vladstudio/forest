# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- (accumulate as learned)

## Patterns That Work
- (successful approaches)

## Patterns That Don't Work
- (failed approaches and why)

## Domain Notes
- Forest is a VS Code extension managing git worktrees with Linear/GitHub integration
- Build: `bun run compile` (type-check + bundle), `bun run check-types` (types only)
- State file at `~/.forest/state.json` with cross-process locking via mkdir
- Must read files before editing them (tool constraint — batch reads first, then edits)
