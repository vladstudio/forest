# Forest Extension — Code Review

**Date**: 2026-04-19
**Scope**: `src/` (24 files, ~3,700 lines)
**Goal**: Actionable findings with enough detail for another developer to fix without re-reading the code.

---

## Priority Map

| # | Priority | Summary | File(s) |
|---|----------|---------|---------|
| 1 | 🔴 P0 | Bug: `runPending` leaks AbortController | `views/ForestWebviewProvider.ts` |
| 2 | 🔴 P0 | Bug: Double error notifications for every failure | `extension.ts` + all commands |
| 3 | 🟡 P1 | `activate()` is a 300-line god-function | `extension.ts` |
| 4 | 🟡 P1 | Duplicated command logic in webview handler | `views/ForestWebviewProvider.ts`, `commands/ship.ts`, `commands/cleanup.ts` |
| 5 | 🟡 P1 | Redundant in-memory locks bypass state locks | `commands/shared.ts`, `commands/cleanup.ts` |
| 6 | 🟡 P1 | `handleMessage` is an untestable 200-line switch | `views/ForestWebviewProvider.ts` |
| 7 | 🟢 P2 | `any`-typed config merge loses type safety | `config.ts` |
| 8 | 🟢 P2 | Confusing naming: `sanitizeBranchForPath` vs `sanitizeBranch` | `commands/shared.ts`, `utils/slug.ts` |
| 9 | 🟢 P2 | `loadSync()` workaround | `state.ts`, `commands/shared.ts` |
| 10 | ⚪ P3 | Circular import: `config.ts` ↔ `context.ts` | `config.ts`, `context.ts` |
| 11 | ⚪ P3 | Useless try/catch in `exec.ts` | `utils/exec.ts` |
| 12 | ⚪ P3 | `notify.ts` progress-bar hack undocumented | `notify.ts` |

---

## 1. 🔴 Bug: `runPending` leaks AbortController

**File**: `src/views/ForestWebviewProvider.ts` — the `runPending` method (search for `private async runPending`)

### Problem

When a new webview action starts while a previous one is still running, the old `AbortController` is silently replaced but never aborted. The previous operation keeps running to completion, consuming resources and potentially writing stale results.

```typescript
// Current code — old controller is abandoned
private async runPending(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const ac = new AbortController();
  this.pendingAbort = ac;  // ← previous controller is lost, never aborted
  try {
    await fn(ac.signal);
  } catch (e: any) {
    if (!ac.signal.aborted) notify.error(`Forest: ${e.message}`);
  } finally {
    this.pendingAbort = null;
    this.postMessage({ type: 'pendingDone' });
    this.refresh();
  }
}
```

### Fix

Abort the previous controller before creating a new one:

```typescript
private async runPending(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
  this.pendingAbort?.abort(); // Cancel any in-flight operation
  const ac = new AbortController();
  this.pendingAbort = ac;
  try {
    await fn(ac.signal);
  } catch (e: any) {
    if (!ac.signal.aborted) notify.error(`Forest: ${e.message}`);
  } finally {
    if (this.pendingAbort === ac) this.pendingAbort = null;
    this.postMessage({ type: 'pendingDone' });
    this.refresh();
  }
}
```

The `this.pendingAbort === ac` guard in `finally` prevents clearing a newer controller if a second operation was started while this one was finishing.

---

## 2. 🔴 Bug: Double error notifications

**File**: `src/extension.ts` — the `reg()` helper (search for `const reg =`)

### Problem

The `reg()` wrapper in `activate()` catches unhandled errors and shows `notify.error()`. But commands like `ship()`, `createTree()`, `start()` already catch errors internally and show their own `notify.error()`. When an error occurs, the user sees two error popups for the same failure.

Example: `createTree()` throws → `start()` catches it and calls `notify.error(e.message)` → the error propagates up to `reg()` which also calls `notify.error()`.

Current code:
```typescript
const reg = (id: string, fn: (...args: any[]) => any) =>
  context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
    try { return await fn(...args); } catch (e: any) {
      outputChannel.appendLine(`[Forest] Command ${id} failed: ${e.stack ?? e.message}`);
      outputChannel.show(true);
      notify.error(`Forest: ${e.message}`);  // ← SECOND notification
    }
  }));
```

### Fix

Make `reg()` a log-only safety net. Commands already handle their own error UX:

```typescript
const reg = (id: string, fn: (...args: any[]) => any) =>
  context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e: any) {
      // Commands handle their own notifications. This is a safety net for uncaught errors.
      outputChannel.appendLine(`[Forest] Unhandled error in ${id}: ${e.stack ?? e.message}`);
      outputChannel.show(true);
    }
  }));
```

**Verification**: After fixing, trigger an error (e.g., try to create a tree when git isn't installed). You should see exactly ONE notification, not two.

---

## 3. 🟡 `activate()` god-function

**File**: `src/extension.ts`

### Problem

`activate()` is ~300 lines doing everything: config loading, state init, orphan pruning, orphan recovery, config watching, command registration (25+ commands), three polling intervals, state-change watching, and disposal. It's the hardest function to read, test, or modify.

### Fix

Extract cohesive blocks into named functions. The goal is `activate()` becomes ~40-50 lines of orchestration.

#### Step 1: Extract polling setup

Create a new file `src/bootstrap/polling.ts`:

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ForestContext } from '../context';
import { getTreesDir } from '../config';
import { deleteWorkspaceFiles } from '../commands/shared';
import * as gh from '../cli/gh';

/** setInterval with a guard flag to prevent overlapping runs. */
function guardedInterval(fn: () => Promise<void>, ms: number): vscode.Disposable {
  let running = false;
  const id = setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch { /* guarded */ } finally { running = false; }
  }, ms);
  return { dispose: () => clearInterval(id) };
}

export function startPolling(ctx: ForestContext): vscode.Disposable[] {
  const { stateManager, repoPath, config, forestProvider, outputChannel } = ctx;
  const disposables: vscode.Disposable[] = [];

  // Auto-cleanup: check merged PRs every 5 minutes
  disposables.push(guardedInterval(async () => {
    // ... (move the auto-cleanup polling block from activate() here verbatim)
  }, 5 * 60 * 1000));

  // Orphan check every 60 seconds
  disposables.push(guardedInterval(async () => {
    // ... (move orphan polling block here)
  }, 60_000));

  // Health refresh every 3 minutes
  const healthId = setInterval(() => forestProvider.refreshTrees(), 3 * 60 * 1000);
  disposables.push({ dispose: () => clearInterval(healthId) });

  return disposables;
}
```

#### Step 2: Extract command registration

Create `src/bootstrap/commands.ts`:

```typescript
import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { ShortcutItem } from '../views/ShortcutsTreeProvider';
// ... other imports

export function registerCommands(ctx: ForestContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const { stateManager, shortcutManager, forestProvider, outputChannel, repoPath, config } = ctx;

  const reg = (id: string, fn: (...args: any[]) => any) =>
    disposables.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try { return await fn(...args); } catch (e: any) {
        outputChannel.appendLine(`[Forest] Unhandled error in ${id}: ${e.stack ?? e.message}`);
        outputChannel.show(true);
      }
    }));

  const lookupTree = (branch?: string) =>
    branch ? stateManager.getTree(stateManager.loadSync(), repoPath, branch) : undefined;
  const andRefresh = <T>(fn: () => Promise<T>) => async () => { await fn(); forestProvider.refreshTrees(); };

  // ... move all reg() calls from activate() here

  return disposables;
}
```

#### Step 3: Extract state initialization / orphan recovery

Create `src/bootstrap/state.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import type { ForestContext } from '../context';
import type { StateManager, ForestState } from '../state';
import { getTreesDir } from '../config';
import { deleteWorkspaceFiles } from '../commands/shared';

export async function initializeState(ctx: ForestContext): Promise<ForestState> {
  const { stateManager, repoPath, outputChannel } = ctx;

  await stateManager.initialize();

  // Clear stale cleaning flags from crashed teardowns
  await stateManager.clearStaleTreeOperations(repoPath);
  const s = await stateManager.load();
  for (const tree of stateManager.getTreesForRepo(s, repoPath)) {
    if (tree.cleaning && tree.path && fs.existsSync(tree.path)) {
      await stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
    }
  }

  // Prune orphans, then recover
  const afterPrune = await pruneOrphans(stateManager, repoPath, outputChannel);
  return recoverOrphanWorktrees(stateManager, repoPath, outputChannel, afterPrune);
}

async function pruneOrphans(...): Promise<ForestState> { /* move from activate() */ }
async function recoverOrphanWorktrees(...): Promise<ForestState> { /* move from activate() */ }
```

#### Step 4: Resulting `activate()`

```typescript
export async function activate(context: vscode.ExtensionContext) {
  const config = await loadConfig();
  if (!config) { /* setup-only registration, same as now */ return; }

  // ... config validation (same as now, ~20 lines)

  const stateManager = new StateManager();
  const outputChannel = vscode.window.createOutputChannel('Forest');

  // State init + orphan recovery
  const postPruneState = await initializeState({ config, repoPath, stateManager, outputChannel } as ForestContext);

  // Detect current tree
  const currentTree = detectCurrentTree(postPruneState);
  const ctx = buildContext(/* ... */);

  // UI providers
  const providers = registerProviders(ctx, context);

  // Commands, polling, state watching
  context.subscriptions.push(
    ...registerCommands(ctx),
    ...startPolling(ctx),
    ...watchState(ctx, previousTrees),
    outputChannel, ctx.shortcutManager, providers.shortcuts, ctx.statusBarManager, stateManager, providers.forest,
  );
}
```

This is a mechanical extraction — no behavior changes. Each piece can be understood in isolation.

---

## 4. 🟡 Duplicated command logic in webview handler

**File**: `src/views/ForestWebviewProvider.ts` — `handleMessage` method

### Problem

The webview re-implements logic that exists in command files:

**Ship example** — two paths exist:

- `commands/ship.ts` → `ship()`: checks uncommitted changes → calls `withTreeOperation` → calls `shipCore()`
- `ForestWebviewProvider.handleMessage` case `'ship'`: checks uncommitted changes → calls `runPending` → calls `withTreeOperation` → calls `shipCore()`

If ship logic changes, **both** must be updated.

**Delete example**:
- `commands/cleanup.ts` → `deleteTree()`: shows QuickPick wizard → calls `executeDeletePlan()`
- `ForestWebviewProvider.handleDeleteSubmit()`: builds plan from webview form → calls `executeDeletePlan()`

### Fix

Make commands the single source of truth. The webview should call the same command functions.

#### Step 1: Make `ship()` accept `AbortSignal` via the context or opts

```typescript
// commands/ship.ts — add signal support
export async function ship(
  ctx: ForestContext,
  treeArg: TreeState | undefined,
  automerge: boolean,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const tree = requireTree(ctx, treeArg, 'ship');
  if (!tree) return;

  if (await git.hasUncommittedChanges(tree.path)) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
    );
    if (choice !== 'Ship Anyway') return;
  }

  const name = displayName(tree);
  const prUrl = await withTreeOperation(
    ctx, tree, 'shipping',
    () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Shipping ${name}...` },
      () => shipCore(ctx, tree, automerge, opts?.signal),
    ),
  );
  if (prUrl === undefined) return;

  if (prUrl) {
    notify.info(`Shipped! PR: ${prUrl}`);
    vscode.env.openExternal(vscode.Uri.parse(prUrl));
  } else {
    notify.info('Shipped!');
  }
}
```

#### Step 2: Replace duplicated webview code with command call

In `ForestWebviewProvider.handleMessage`, replace the entire `'ship'` / `'shipMerge'` case:

```typescript
// BEFORE (~30 lines):
case 'ship':
case 'shipMerge': {
  if (!tree?.path || !ctx) { bail(); return; }
  if (await git.hasUncommittedChanges(tree.path)) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
    );
    if (choice !== 'Ship Anyway') { bail(); return; }
  }
  const automerge = command === 'shipMerge';
  await this.runPending(async (signal) => {
    const prUrl = await withTreeOperation(
      ctx, tree as TreeState & { path: string }, 'shipping',
      () => shipCore(ctx, tree as TreeState & { path: string }, automerge, signal),
    );
    if (prUrl) {
      notify.info(`Shipped! PR: ${prUrl}`);
      vscode.env.openExternal(vscode.Uri.parse(prUrl));
    } else if (prUrl !== undefined) {
      notify.info('Shipped!');
    }
  });
  break;
}

// AFTER (~5 lines):
case 'ship':
case 'shipMerge': {
  if (!tree?.path || !ctx) { bail(); return; }
  await ship(ctx, tree, command === 'shipMerge');
  break;
}
```

Note: the `runPending` wrapper is dropped. If abort-signaling is needed, thread it through the command function. For now, ship doesn't need it — the `withTreeOperation` inside `ship()` is sufficient.

#### Step 3: Same pattern for delete

The webview's `handleDeleteSubmit` is trickier because the webview provides a pre-built `DeletePlan` (no QuickPick wizard needed — the webview has its own form). Keep `handleDeleteSubmit` as-is since it calls `executeDeletePlan()` (a shared function), not re-implementing it. This is fine — the wizard is the only duplicated part, and the webview legitimately has its own form.

**What to check**: Search `ForestWebviewProvider.ts` for inline calls to `shipCore`, `executeDeletePlan`, `git.pullMerge`, `copyConfigFiles`, `withTreeOperation`. Each of these should be going through a command function or shared helper instead.

---

## 5. 🟡 Redundant in-memory locks

**Files**: `src/commands/shared.ts`, `src/commands/cleanup.ts`

### Problem

Two separate locking mechanisms exist:

1. **State-based locks** in `StateManager`: `busyOperation`, `tryStartTreeOperation()`, `clearTreeOperation()` — persist to disk, survive crashes, work across windows.
2. **In-memory `Set` locks**: `createInProgress` (shared.ts line ~167), `teardownInProgress` (cleanup.ts line ~13) — only work within a single process, lost on crash.

`createTree()` uses `createInProgress` but never calls `tryStartTreeOperation`. `teardownTree()` uses both `teardownInProgress` AND `cleaning: true` in state. Two locks for one operation.

The in-memory Sets don't protect across windows (each VS Code window has its own JS process). Meanwhile, the state-based locks do.

### Fix

#### `createTree` in `src/commands/shared.ts`

Remove the `createInProgress` Set. Use `tryStartTreeOperation` / `clearTreeOperation`:

```typescript
// DELETE this line:
const createInProgress = new Set<string>();

// In createTree(), replace the guard:
export async function createTree(opts: { ... }): Promise<TreeState> {
  const { branch, config, stateManager, repoPath, ... } = opts;

  // BEFORE:
  // const createKey = `${repoPath}:${branch}`;
  // if (createInProgress.has(createKey)) throw new Error('Tree creation already in progress.');
  // createInProgress.add(createKey);
  // try { ... } finally { createInProgress.delete(createKey); }

  // AFTER:
  const lockResult = await stateManager.tryStartTreeOperation(repoPath, branch, 'creating');
  if (!lockResult.started) {
    throw new Error(`Tree is already ${lockResult.active}.`);
  }
  try {
    // ... existing creation logic ...
  } catch (e) {
    // Cleanup on failure (same as current)
    await stateManager.removeTree(repoPath, branch);
    await git.removeWorktree(repoPath, treePath).catch(() => {});
    if (!existingBranch) await git.deleteBranch(repoPath, branch).catch(() => {});
    throw e;
  } finally {
    await stateManager.clearTreeOperation(repoPath, branch, 'creating').catch(() => {});
  }
}
```

#### `teardownTree` in `src/commands/cleanup.ts`

Remove the `teardownInProgress` Set. The `cleaning: true` state flag already prevents concurrent teardown:

```typescript
// DELETE this line:
const teardownInProgress = new Set<string>();

// In teardownTree(), remove the Set guard:
async function teardownTree(ctx: ForestContext, tree: TreeState, opts: TeardownOpts = {}): Promise<boolean> {
  // BEFORE:
  // const key = `${tree.repoPath}:${tree.branch}`;
  // if (teardownInProgress.has(key)) return false;
  // teardownInProgress.add(key);

  // AFTER: just use the state-based cleaning flag (already present)
  await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: true });

  // ... rest stays the same ...
  // In finally: teardownInProgress.delete(key) → remove that line too
}
```

The `cleaning: true` flag already serves as the lock — `ensureTreeIdle()` checks it and returns false. The `teardownInProgress` Set was redundant.

---

## 6. 🟡 `handleMessage` is an untestable 200-line switch

**File**: `src/views/ForestWebviewProvider.ts`

### Problem

A single 200-line method handles ~25 different message types with interleaved awaits, early returns, `bail()` calls, and nested `runPending`/`withTreeOperation` wrapping.

### Fix

Extract each case into its own method, then dispatch from a map.

#### Step 1: Extract handler methods

Move each `case` block into a named method on the class:

```typescript
private async handlePull(tree: TreeState | undefined, ctx: ForestContext): Promise<void> {
  if (!tree?.path) { this.bail(); return; }
  await this.runTreeAction(tree, 'pulling', (signal) =>
    git.pull(tree.path!, tree.branch, { signal }),
  );
}

private async handlePush(tree: TreeState | undefined, ctx: ForestContext): Promise<void> {
  if (!tree?.path) { this.bail(); return; }
  await this.runTreeAction(tree, 'pushing', (signal) =>
    git.pushBranch(tree.path!, tree.branch, { signal }),
  );
}

// ... etc for each case
```

Factor out the common `runTreeAction` helper (already kind of exists inline):

```typescript
private async runTreeAction(
  tree: TreeState, busyOperation: string, fn: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  await this.runPending(async (signal) => {
    await withTreeOperation(
      this.ctx!, tree as TreeState & { path: string }, busyOperation,
      () => fn(signal),
    );
  });
}

/** Send pendingDone if the command won't reach runPending. */
private bail(): void {
  this.postMessage({ type: 'pendingDone' });
}
```

#### Step 2: Replace the switch with a dispatch map

```typescript
private readonly treeHandlers: Record<string, (tree: TreeState | undefined, ctx: ForestContext) => Promise<void>> = {
  pull: (tree, ctx) => this.handlePull(tree, ctx),
  push: (tree, ctx) => this.handlePush(tree, ctx),
  mergeFromMain: (tree, ctx) => this.handleMergeFromMain(tree, ctx),
  ship: (tree, ctx) => this.handleShip(tree, ctx, false),
  shipMerge: (tree, ctx) => this.handleShip(tree, ctx, true),
  delete: (tree, ctx) => this.handleDelete(tree, ctx),
  // ... etc
};

private async handleTreeCommand(command: string, key: string): Promise<void> {
  const handler = this.treeHandlers[command];
  if (!handler) return;

  const colonIdx = key.indexOf(':');
  const repoPath = key.slice(0, colonIdx);
  const branch = key.slice(colonIdx + 1);
  const state = await this.stateManager.load();
  const tree = this.stateManager.getTree(state, repoPath, branch);

  await handler(tree, this.ctx!);
}
```

#### Step 3: Simplify `handleMessage`

```typescript
private async handleMessage(msg: Record<string, any>): Promise<void> {
  const { command, key } = msg;

  // Main-repo commands
  if (key === '__main__') return this.handleMainCommand(command);

  // Form commands (no key)
  if (command === 'pickBranch') return this.handlePickBranch();
  if (command === 'pickIssue') return this.handlePickIssue();
  if (command === 'createForm:submit') return this.handleCreateSubmit(msg);
  if (command === 'deleteForm:submit') return this.handleDeleteSubmit(msg);

  // Cancel
  if (command === 'cancelPending') { this.pendingAbort?.abort(); return; }

  // Tree commands
  if (key && this.treeHandlers[command]) {
    return this.handleTreeCommand(command, key);
  }
}
```

**After this refactor + Issue 4 (duplicated paths)**, many of the extracted handler methods become 3-5 lines since they delegate to command functions.

---

## 7. 🟢 `any`-typed config merge

**File**: `src/config.ts`

### Problem

`mergeConfig(base: any, local: any): any` and `normalizeShortcut(raw: any): any` lose all type information. `loadConfig()` ends with `return merged as ForestConfig` — an unsafe cast with no validation.

### Fix

#### Step 1: Type the merge function

```typescript
function mergeConfig<T extends Record<string, any>>(base: T, local: Partial<T>): T {
  const result = { ...base } as Record<string, any>;
  for (const key of Object.keys(local)) {
    const localVal = local[key as keyof T];
    if (localVal === null) continue;

    if (key === 'shortcuts' && Array.isArray(localVal)) {
      // Merge named arrays by name (unchanged logic)
      const baseArr = [...(result[key] || [])];
      for (const item of localVal) {
        const idx = baseArr.findIndex((b: any) => b.name === item.name);
        if (idx >= 0) baseArr[idx] = { ...baseArr[idx], ...item };
        else baseArr.push(item);
      }
      result[key] = baseArr;
    } else if (typeof localVal === 'object' && !Array.isArray(localVal)) {
      result[key] = mergeConfig(result[key] || {}, localVal);
    } else {
      result[key] = localVal;
    }
  }
  return result as T;
}
```

#### Step 2: Type the normalize function

```typescript
interface RawShortcut {
  name: string;
  type?: 'terminal' | 'browser' | 'file';
  command?: string;
  url?: string;
  path?: string;
  onNewTree?: boolean;
  env?: Record<string, string>;
  browser?: string;
}

function normalizeShortcut(raw: RawShortcut): ShortcutConfig {
  if (raw.type) return raw as ShortcutConfig;
  if (raw.url) return { ...raw, type: 'browser' };
  if (raw.path) return { ...raw, type: 'file' };
  return { ...raw, type: 'terminal' };
}
```

#### Step 3: Validate before returning

```typescript
// At the end of loadConfig(), before returning:
if (!merged.baseBranch || typeof merged.baseBranch !== 'string') {
  notify.error('Forest config: "baseBranch" is required and must be a string.');
  return null;
}
if (!Array.isArray(merged.shortcuts)) {
  notify.error('Forest config: "shortcuts" must be an array.');
  return null;
}
```

---

## 8. 🟢 Confusing naming: two sanitize functions

**Files**: `src/commands/shared.ts` (line ~111), `src/utils/slug.ts`

### Problem

- `sanitizeBranch(value)` in `utils/slug.ts` — sanitizes for git branch names
- `sanitizeBranchForPath(branch)` in `commands/shared.ts` — sanitizes for filesystem paths

Similar names, different purposes. A developer will reach for the wrong one.

### Fix

Rename `sanitizeBranchForPath` to `sanitizeForFilePath` and move it to `utils/slug.ts` so both are co-located:

```typescript
// utils/slug.ts — add this function
/** Sanitize a string for use as a directory/file name (replaces /, .., special chars). */
export function sanitizeForFilePath(value: string): string {
  return value
    .replace(/\.\./g, '')
    .replace(/\//g, '--')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-');
}
```

Then update all call sites in `commands/shared.ts`:
- `sanitizeBranchForPath(branch)` → `sanitizeForFilePath(branch)`

Remove the private function from `shared.ts`.

---

## 9. 🟢 `loadSync()` workaround

**Files**: `src/state.ts` (line ~83), `src/commands/shared.ts` (`requireTree`)

### Problem

`loadSync()` reads the state file synchronously. It exists because `requireTree()` is called synchronously from command registration helpers (`lookupTree`, `andRefresh` in `extension.ts`).

### Fix

#### Step 1: Make `requireTree` async

```typescript
// commands/shared.ts — change signature
export async function requireTree(
  ctx: ForestContext, arg: TreeState | string | undefined, action: string,
): Promise<(TreeState & { path: string }) | undefined> {
  const tree = typeof arg === 'string'
    ? ctx.stateManager.getTree(await ctx.stateManager.load(), ctx.repoPath, arg)
    //                  ^^^^^ await instead of sync
    : arg ?? ctx.currentTree;
  // ... rest unchanged
}
```

#### Step 2: Update callers — they're all already in async functions

The callers (`ship()`, `update()`, `rebase()`, `pull()`, `push()`, `deleteTree()`, `cleanupMerged()`) are all `async`. Just add `await`:

```typescript
// Before:
const tree = requireTree(ctx, treeArg, 'ship');

// After:
const tree = await requireTree(ctx, treeArg, 'ship');
```

#### Step 3: Remove `loadSync()` from `state.ts`

#### Step 4: Fix `lookupTree` in `extension.ts`

```typescript
// Before:
const lookupTree = (branch?: string) =>
  branch ? stateManager.getTree(stateManager.loadSync(), repoPath, branch) : undefined;

// After:
const lookupTree = async (branch?: string) =>
  branch ? stateManager.getTree(await stateManager.load(), repoPath, branch) : undefined;
```

And update the callers:

```typescript
// Before:
reg('forest.ship', (branch?: string) => andRefresh(() => ship(ctx, lookupTree(branch), false))());

// After:
reg('forest.ship', async (branch?: string) => {
  const tree = await lookupTree(branch);
  await ship(ctx, tree, false);
  forestProvider.refreshTrees();
});
```

This makes `andRefresh` / `lookupTree` unnecessary — inline them into the `reg()` calls.

---

## 10. ⚪ Circular import: `config.ts` ↔ `context.ts`

### Problem

`config.ts` imports `resolveMainRepo` from `context.ts`. `context.ts` imports `ForestConfig` type from `config.ts`. TypeScript handles this at runtime, but it's a structural smell.

### Fix

Move `resolveMainRepo` and `getRepoPath` to a new file `src/utils/repo.ts`:

```typescript
// src/utils/repo.ts
import * as path from 'path';
import * as fs from 'fs';

/** Resolve main repo root from any path (worktree or main). */
export function resolveMainRepo(wsPath: string): string {
  const gitPath = path.join(wsPath, '.git');
  try {
    if (fs.statSync(gitPath).isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const gitdir = path.resolve(wsPath, content.replace('gitdir: ', ''));
      try {
        const commondir = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
        return path.dirname(path.resolve(gitdir, commondir));
      } catch {
        return path.resolve(gitdir, '..', '..', '..');
      }
    }
  } catch { /* not a worktree */ }
  return wsPath;
}
```

Then:
- `config.ts` imports from `./utils/repo`
- `context.ts` imports from `./utils/repo`
- Neither imports the other

---

## 11. ⚪ Useless try/catch in `exec.ts`

### Problem

```typescript
export async function exec(...): Promise<ExecResult> {
  try {
    const r = await execFileAsync(command, args, { ... });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (e: any) {
    throw e;  // ← catches only to re-throw
  }
}
```

Same in `execShell()`.

### Fix

Remove the try/catch:

```typescript
export async function exec(
  command: string, args: string[],
  opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const r = await execFileAsync(command, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
    signal: opts?.signal,
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}
```

---

## 12. ⚪ `notify.ts` progress-bar hack

### Problem

`notify.info` / `notify.warn` abuse `withProgress` to create auto-dismissing toasts. This shows a spinner (misleading) and uses non-standard styling. However, VS Code has no native auto-dismiss API, so this hack is *necessary*.

### Fix

Don't change the behavior — just document the reasoning:

```typescript
import * as vscode from 'vscode';

// VS Code has no native auto-dismiss API for info/warn messages.
// We abuse withProgress to get a timed notification. The spinner is an
// acceptable trade-off for auto-dismiss behavior.
const auto = (title: string, ms: number) =>
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => new Promise<void>(r => setTimeout(r, ms)),
  );

export const notify = {
  info: (msg: string) => auto(msg, 4000),
  warn: (msg: string) => auto(`$(warning) ${msg}`, 5000),
  error: (msg: string) => { vscode.window.showErrorMessage(msg); },
};
```

---

## Recommended fix order

1. **Issue 1** (AbortController leak) — 5-line change, fixes a real bug
2. **Issue 2** (double notifications) — 2-line change, fixes a UX bug
3. **Issue 8** (naming) — rename + move, zero risk
4. **Issue 11** (useless try/catch) — delete lines, zero risk
5. **Issue 12** (add comment to notify) — add comment, zero risk
6. **Issue 9** (remove loadSync) — small refactor, run tests
7. **Issue 10** (circular import) — move functions, zero risk
8. **Issue 5** (remove in-memory locks) — medium risk, test concurrent scenarios
9. **Issue 7** (type config merge) — medium refactor, test with real configs
10. **Issue 6** (break up handleMessage) — large refactor, do after Issue 4
11. **Issue 4** (duplicated paths) — large refactor, test every webview button
12. **Issue 3** (break up activate) — mechanical extraction, do last

Issues 6, 4, and 3 are interconnected — the webview handler cleanup (6) is easier after the duplicated logic is removed (4), which is easier after commands have a clean interface. Do them in that order.
