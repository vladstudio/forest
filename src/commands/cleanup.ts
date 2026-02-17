import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { getRepoPath } from '../context';
import { runStep, updateLinear, workspaceFilePath, resumeTree } from './shared';

function resolveTree(ctx: ForestContext, branchArg?: string): TreeState | undefined {
  return branchArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), branchArg)
    : ctx.currentTree;
}

const teardownInProgress = new Set<string>();

async function teardownTree(ctx: ForestContext, tree: TreeState): Promise<void> {
  const key = `${tree.repoPath}:${tree.branch}`;
  if (teardownInProgress.has(key)) return;
  teardownInProgress.add(key);
  try {
    const shouldClose = ctx.currentTree?.branch === tree.branch;
    await ctx.stateManager.removeTree(tree.repoPath, tree.branch);
    try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.branch)); } catch {}
    ctx.outputChannel.appendLine('[Forest] State updated');
    if (shouldClose) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    } else if (tree.path) {
      await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));
      await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch));
    } else {
      // Shelved — no worktree to remove, just delete branch
      await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch));
    }
  } finally {
    teardownInProgress.delete(key);
  }
}

export async function cleanup(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = resolveTree(ctx, branchArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to clean up. Run from a tree window or select from sidebar.');
    return;
  }
  const config = ctx.config;

  const confirm = await vscode.window.showWarningMessage(
    `Cleanup ${displayName(tree)}?\n\nThis will merge PR, remove worktree, and clean up.`,
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
      if (config.github.enabled && await gh.isAvailable()) {
        progress.report({ message: 'Merging PR...' });
        if (!await runStep(ctx, 'Merge PR', () => gh.mergePR(tree.path!))) return;
      }

      progress.report({ message: 'Updating ticket...' });
      if (tree.ticketId) await updateLinear(ctx, tree.ticketId, config.linear.statuses.onCleanup);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

export async function cancel(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = resolveTree(ctx, branchArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to cancel. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Cancel ${displayName(tree)}?\n\nThis will remove the worktree and branch without merging.`,
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
  const tree = resolveTree(ctx, branchArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to shelve. Run from a tree window or select from sidebar.');
    return;
  }

  if (!tree.path) {
    vscode.window.showInformationMessage('Tree is already shelved.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Shelve ${displayName(tree)}?\n\nThis will remove the worktree but keep the branch.`,
    { modal: true }, 'Shelve',
  );
  if (confirm !== 'Shelve') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shelving ${displayName(tree)}...` },
    async (progress) => {
      const shouldClose = ctx.currentTree?.branch === tree.branch;

      // Clear path in state (mark as shelved)
      await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { path: undefined });
      try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.branch)); } catch {}

      if (shouldClose) {
        await vscode.commands.executeCommand('workbench.action.closeWindow');
      } else {
        progress.report({ message: 'Removing worktree...' });
        await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));
      }
    },
  );
}

export async function resume(ctx: ForestContext, branchArg?: string): Promise<void> {
  const tree = resolveTree(ctx, branchArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to resume.');
    return;
  }

  if (tree.path) {
    vscode.window.showInformationMessage('Tree already has a worktree. Use Switch instead.');
    return;
  }

  try {
    await resumeTree({ tree, config: ctx.config, stateManager: ctx.stateManager });
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}
