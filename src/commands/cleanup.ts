import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { getRepoPath } from '../context';

function resolveTree(ctx: ForestContext, ticketIdArg?: string): TreeState | undefined {
  return ticketIdArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), ticketIdArg)
    : ctx.currentTree;
}

async function teardownTree(ctx: ForestContext, tree: TreeState): Promise<void> {
  const shouldClose = ctx.currentTree?.ticketId === tree.ticketId;
  await git.removeWorktree(tree.repoPath, tree.path).catch(() => {});
  await git.deleteBranch(tree.repoPath, tree.branch);
  await ctx.stateManager.removeTree(getRepoPath(), tree.ticketId);
  if (shouldClose) {
    vscode.commands.executeCommand('workbench.action.closeWindow');
  }
}

async function updateLinear(config: import('../config').ForestConfig, ticketId: string, status: string): Promise<void> {
  if (config.linear.enabled && await linear.isAvailable()) {
    linear.updateIssueState(ticketId, status).catch(() => {});
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
        try {
          await gh.mergePR(tree.path);
        } catch (e: any) {
          vscode.window.showErrorMessage(`PR merge failed: ${e.message}`);
          return;
        }
      }

      progress.report({ message: 'Updating ticket...' });
      await updateLinear(config, tree.ticketId, config.linear.statuses.onCleanup);

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
  const config = ctx.config;

  const confirm = await vscode.window.showWarningMessage(
    `Cancel ${tree.ticketId}: ${tree.title}?\n\nThis will remove the worktree and branch without merging.`,
    { modal: true }, 'Cancel Tree',
  );
  if (confirm !== 'Cancel Tree') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Canceling ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Updating ticket...' });
      await updateLinear(config, tree.ticketId, config.linear.statuses.onCancel);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  await updateLinear(ctx.config, tree.ticketId, ctx.config.linear.statuses.onCleanup);
  await teardownTree(ctx, tree);
}
