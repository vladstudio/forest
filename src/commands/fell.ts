import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { getRepoPath } from '../context';
import type { TreeState } from '../state';

export async function fell(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  let tree: TreeState | undefined;

  if (ticketIdArg) {
    const state = await ctx.stateManager.load();
    tree = ctx.stateManager.getTree(state, getRepoPath(), ticketIdArg);
  } else {
    tree = ctx.currentTree;
  }

  if (!tree) {
    vscode.window.showErrorMessage('No tree to fell. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Fell ${tree.ticketId}: ${tree.title}?\n\nThis will merge PR, remove worktree, and clean up.`,
    { modal: true }, 'Fell',
  );
  if (confirm !== 'Fell') return;

  // Check uncommitted changes
  if (await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showErrorMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Felling ${tree.ticketId}...` },
    async (progress) => {
      // Merge PR
      if (ctx.config.integrations.github && await gh.isAvailable()) {
        progress.report({ message: 'Merging PR...' });
        try {
          await gh.mergePR(tree!.path);
        } catch (e: any) {
          vscode.window.showErrorMessage(`PR merge failed: ${e.message}`);
          return;
        }
      }

      // Update Linear
      if (ctx.config.integrations.linear && await linear.isAvailable()) {
        progress.report({ message: 'Updating ticket...' });
        linear.updateIssueState(tree!.ticketId, 'Done').catch(() => {});
      }

      // Remove worktree (from main repo, not worktree itself)
      progress.report({ message: 'Removing worktree...' });
      await git.removeWorktree(tree!.repoPath, tree!.path);
      await git.deleteBranch(tree!.repoPath, tree!.branch);

      // Remove from state
      await ctx.stateManager.removeTree(getRepoPath(), tree!.ticketId);

      // Close window if we're in the felled tree
      if (ctx.currentTree?.ticketId === tree!.ticketId) {
        vscode.commands.executeCommand('workbench.action.closeWindow');
      }
    },
  );
}
