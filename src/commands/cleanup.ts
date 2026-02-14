import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { getRepoPath } from '../context';

export async function cleanup(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = ticketIdArg
    ? ctx.stateManager.getTree(await ctx.stateManager.load(), getRepoPath(), ticketIdArg)
    : ctx.currentTree;

  if (!tree) {
    vscode.window.showErrorMessage('No tree to clean up. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Cleanup ${tree.ticketId}: ${tree.title}?\n\nThis will merge PR, remove worktree, and clean up.`,
    { modal: true }, 'Cleanup',
  );
  if (confirm !== 'Cleanup') return;

  // Check uncommitted changes
  if (await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showErrorMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cleaning up ${tree.ticketId}...` },
    async (progress) => {
      // Merge PR
      if (ctx.config.integrations.github && await gh.isAvailable()) {
        progress.report({ message: 'Merging PR...' });
        try {
          await gh.mergePR(tree.path);
        } catch (e: any) {
          vscode.window.showErrorMessage(`PR merge failed: ${e.message}`);
          return;
        }
      }

      // Update Linear
      if (ctx.config.integrations.linear && await linear.isAvailable()) {
        progress.report({ message: 'Updating ticket...' });
        linear.updateIssueState(tree.ticketId, ctx.config.linearStatuses.onCleanup).catch(() => {});
      }

      // Remove worktree (from main repo, not worktree itself)
      progress.report({ message: 'Removing worktree...' });
      await git.removeWorktree(tree.repoPath, tree.path);
      await git.deleteBranch(tree.repoPath, tree.branch);

      // Remove from state
      await ctx.stateManager.removeTree(getRepoPath(), tree.ticketId);

      // Close window if we're in the cleaned-up tree
      if (ctx.currentTree?.ticketId === tree.ticketId) {
        vscode.commands.executeCommand('workbench.action.closeWindow');
      }
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  if (ctx.config.integrations.linear && await linear.isAvailable()) {
    linear.updateIssueState(tree.ticketId, ctx.config.linearStatuses.onCleanup).catch(() => {});
  }
  await git.removeWorktree(tree.repoPath, tree.path).catch(() => {});
  await git.deleteBranch(tree.repoPath, tree.branch);
  await ctx.stateManager.removeTree(getRepoPath(), tree.ticketId);
  if (ctx.currentTree?.ticketId === tree.ticketId) {
    vscode.commands.executeCommand('workbench.action.closeWindow');
  }
}
