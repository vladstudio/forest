import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { getRepoPath } from '../context';
import { runStep, updateLinear } from './shared';

function resolveTree(ctx: ForestContext, ticketIdArg?: string): TreeState | undefined {
  return ticketIdArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), ticketIdArg)
    : ctx.currentTree;
}

const teardownInProgress = new Set<string>();

async function teardownTree(ctx: ForestContext, tree: TreeState): Promise<void> {
  const key = `${tree.repoPath}:${tree.ticketId}`;
  if (teardownInProgress.has(key)) return;
  teardownInProgress.add(key);
  try {
    const shouldClose = ctx.currentTree?.ticketId === tree.ticketId;
    // Remove state first — if we're in the tree window, removing the worktree
    // deletes the workspace directory, which causes VS Code to kill the extension
    // host before subsequent steps (state cleanup, branch deletion) can run.
    await ctx.stateManager.removeTree(tree.repoPath, tree.ticketId);
    ctx.outputChannel.appendLine('[Forest] State updated');
    // Close window before removing worktree so the directory isn't held open.
    if (shouldClose) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
    // Git cleanup — runs only if extension host survives (i.e. invoked from main window).
    // Remove worktree first so the branch is no longer checked out.
    await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path));
    await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch));
  } finally {
    teardownInProgress.delete(key);
  }
}

export async function cleanup(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = resolveTree(ctx, ticketIdArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to clean up. Run from a tree window or select from sidebar.');
    return;
  }
  const config = ctx.config;

  const confirm = await vscode.window.showWarningMessage(
    `Cleanup ${tree.ticketId}: ${tree.title}?\n\nThis will merge PR, remove worktree, and clean up.`,
    { modal: true }, 'Cleanup',
  );
  if (confirm !== 'Cleanup') return;

  if (await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showErrorMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cleaning up ${tree.ticketId}...` },
    async (progress) => {
      if (config.github.enabled && await gh.isAvailable()) {
        progress.report({ message: 'Merging PR...' });
        if (!await runStep(ctx, 'Merge PR', () => gh.mergePR(tree.path))) return;
      }

      progress.report({ message: 'Updating ticket...' });
      await updateLinear(ctx, tree.ticketId, config.linear.statuses.onCleanup);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

export async function cancel(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = resolveTree(ctx, ticketIdArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to cancel. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Cancel ${tree.ticketId}: ${tree.title}?\n\nThis will remove the worktree and branch without merging.`,
    { modal: true }, 'Cancel Tree',
  );
  if (confirm !== 'Cancel Tree') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Canceling ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Updating ticket...' });
      await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCancel);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCleanup);
  await teardownTree(ctx, tree);
}
