import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { getRepoPath } from '../context';
import { deleteWorkspaceFiles, runStep, updateLinear } from './shared';
import { log } from '../logger';

function resolveTree(ctx: ForestContext, branchArg?: string): TreeState | undefined {
  return branchArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), branchArg)
    : ctx.currentTree;
}

function requireTree(ctx: ForestContext, branchArg: string | undefined, action: string): TreeState | undefined {
  const tree = resolveTree(ctx, branchArg);
  if (!tree) vscode.window.showErrorMessage(`No tree to ${action}. Run from a tree window or select from sidebar.`);
  return tree;
}

const teardownInProgress = new Set<string>();

interface TeardownOpts {
  deleteLocal?: boolean;
  deleteRemote?: boolean;
}

async function teardownTree(ctx: ForestContext, tree: TreeState, opts: TeardownOpts = {}): Promise<boolean> {
  const key = `${tree.repoPath}:${tree.branch}`;
  if (teardownInProgress.has(key)) { log.warn(`teardownTree already in progress: ${tree.branch}`); return false; }
  log.info(`teardownTree: ${tree.branch}`);
  teardownInProgress.add(key);
  let removedFromState = false;
  const clearCleaning = () => ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
  try {
    await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: true });
    const shouldClose = ctx.currentTree?.branch === tree.branch;
    if (tree.path) {
      const removed = await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));
      if (!removed) {
        // Fail closed: keep the tree in state so the user can retry cleanup.
        await clearCleaning();
        return false;
      }
    }
    if (opts.deleteLocal) {
      const deleted = await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch, { skipRemote: !opts.deleteRemote }));
      if (!deleted) {
        // Branch deletion is destructive too; don't forget the tree on partial failure.
        await clearCleaning();
        return false;
      }
    }
    await ctx.stateManager.removeTree(tree.repoPath, tree.branch);
    removedFromState = true;
    deleteWorkspaceFiles(tree);
    ctx.outputChannel.appendLine('[Forest] State updated');
    if (shouldClose) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
    return true;
  } catch (e: any) {
    if (!removedFromState) {
      await clearCleaning().catch(() => {});
    }
    throw e;
  } finally {
    teardownInProgress.delete(key);
  }
}

const stepList = (...items: (string | false | 0 | '' | null | undefined)[]) =>
  (items.filter(Boolean) as string[]).map((s, i) => `${i + 1}. ${s}`).join('\n');

export async function cleanup(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'clean up');
  if (!tree) return;
  const config = ctx.config;
  const ghEnabled = config.github.enabled && !!tree.path && await gh.isAvailable();
  const hasLinear = !!tree.ticketId && config.linear.enabled;
  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Cleanup ${displayName(tree)}?\n\n${stepList(
      ghEnabled && 'Squash-merge the PR',
      hasLinear && `Move ${tree.ticketId} → ${config.linear.statuses.onCleanup}`,
      'Delete tree + branches',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Cleanup',
  );
  if (confirm !== 'Cleanup') return;

  if (tree.path && await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showErrorMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cleaning up ${displayName(tree)}...` },
    async (progress) => {
      let mergeFailed = false;
      progress.report({ message: 'Merging & updating...' });
      await Promise.all([
        ghEnabled
          ? runStep(ctx, 'Merge PR', () => gh.mergePR(tree.path!)).then(ok => { if (!ok) mergeFailed = true; })
          : Promise.resolve(),
        tree.ticketId && config.linear.enabled
          ? updateLinear(ctx, tree.ticketId, config.linear.statuses.onCleanup)
          : Promise.resolve(),
      ]);

      if (mergeFailed) return;

      progress.report({ message: 'Removing tree...' });
      // gh merge already deletes the remote branch
      await teardownTree(ctx, tree, { deleteLocal: true, deleteRemote: !ghEnabled });
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  if (tree.ticketId) await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCleanup);
  await teardownTree(ctx, tree, { deleteLocal: true, deleteRemote: true });
}

/** Delete tree, keep both local and remote branches. */
export async function deleteTree(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'delete');
  if (!tree) return;

  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${displayName(tree)}?\n\n${stepList(
      'Remove worktree (keep branches)',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Delete',
  );
  if (confirm !== 'Delete') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${displayName(tree)}...` },
    async () => {
      await teardownTree(ctx, tree);
    },
  );
}

/** Delete tree + local branch, keep remote branch. */
export async function deleteTreeLocal(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'delete');
  if (!tree) return;

  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${displayName(tree)} + local branch?\n\n${stepList(
      'Remove worktree + local branch (keep remote)',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Delete',
  );
  if (confirm !== 'Delete') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${displayName(tree)}...` },
    async () => {
      await teardownTree(ctx, tree, { deleteLocal: true });
    },
  );
}

/** Delete tree + all branches, cancel Linear issue. */
export async function deleteTreeAll(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'delete');
  if (!tree) return;

  const hasLinear = !!tree.ticketId && ctx.config.linear.enabled;
  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${displayName(tree)} + all branches?\n\n${stepList(
      hasLinear && `Move ${tree.ticketId} → ${ctx.config.linear.statuses.onCancel}`,
      'Remove worktree + local & remote branches',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Delete',
  );
  if (confirm !== 'Delete') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${displayName(tree)}...` },
    async (progress) => {
      if (tree.ticketId) {
        progress.report({ message: 'Updating ticket...' });
        await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCancel);
      }
      progress.report({ message: 'Removing tree...' });
      await teardownTree(ctx, tree, { deleteLocal: true, deleteRemote: true });
    },
  );
}
