import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { getRepoPath } from '../context';
import { runStep, updateLinear, workspaceFilePath } from './shared';
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

async function teardownTree(ctx: ForestContext, tree: TreeState, opts?: { skipRemoteBranchDelete?: boolean }): Promise<void> {
  const key = `${tree.repoPath}:${tree.branch}`;
  if (teardownInProgress.has(key)) { log.warn(`teardownTree already in progress: ${tree.branch}`); return; }
  log.info(`teardownTree: ${tree.branch}`);
  teardownInProgress.add(key);
  try {
    await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: true });
    const shouldClose = ctx.currentTree?.branch === tree.branch;
    // Remove worktree & branch BEFORE state so other windows don't race to clean up.
    if (tree.path) {
      await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));
    }
    await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch, { skipRemote: opts?.skipRemoteBranchDelete }));
    await ctx.stateManager.removeTree(tree.repoPath, tree.branch);
    try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.branch)); } catch {}
    ctx.outputChannel.appendLine('[Forest] State updated');
    if (shouldClose) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
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
      tree.path ? 'Remove worktree, delete branch' : 'Delete branch',
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

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree, { skipRemoteBranchDelete: ghEnabled });
    },
  );
}

export async function cancel(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'cancel');
  if (!tree) return;

  const hasLinear = !!tree.ticketId && ctx.config.linear.enabled;
  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Cancel ${displayName(tree)}?\n\n${stepList(
      hasLinear && `Move ${tree.ticketId} → ${ctx.config.linear.statuses.onCancel}`,
      tree.path ? 'Remove worktree, delete branch' : 'Delete branch',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Cancel Tree',
  );
  if (confirm !== 'Cancel Tree') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Canceling ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: 'Updating ticket...' });
      if (tree.ticketId) await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCancel);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  if (tree.ticketId) await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCleanup);
  await teardownTree(ctx, tree);
}

export async function shelve(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'shelve');
  if (!tree) return;

  const willClose = ctx.currentTree?.branch === tree.branch;

  const confirm = await vscode.window.showWarningMessage(
    `Shelve ${displayName(tree)}?\n\n${stepList(
      'Remove worktree (keep branch)',
      willClose && 'Close this window',
    )}`,
    { modal: true }, 'Shelve',
  );
  if (confirm !== 'Shelve') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shelving ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: 'Removing worktree...' });
      await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));

      await ctx.stateManager.removeTree(tree.repoPath, tree.branch);
      try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.branch)); } catch {}

      if (willClose) {
        await vscode.commands.executeCommand('workbench.action.closeWindow');
      }
    },
  );
}

