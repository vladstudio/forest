import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import * as linear from '../cli/linear';
import { getRepoPath } from '../context';

export async function ship(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) {
    vscode.window.showErrorMessage('Ship must be run from a tree window.');
    return;
  }
  const tree = ctx.currentTree;

  // Check uncommitted changes
  if (await git.hasUncommittedChanges(tree.path)) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
    );
    if (choice !== 'Ship Anyway') return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shipping ${tree.ticketId}...` },
    async (progress) => {
      // Push
      progress.report({ message: 'Pushing branch...' });
      await git.pushBranch(tree.path, tree.branch);

      // Create PR + update Linear
      let prUrl: string | null = null;
      if (ctx.config.integrations.linear && await linear.isAvailable()) {
        progress.report({ message: 'Creating PR...' });
        prUrl = await linear.createPR(tree.ticketId, ctx.config.baseBranch);
        linear.updateIssueState(tree.ticketId, ctx.config.linearStatuses.onShip).catch(() => {});
      }

      // Update state
      await ctx.stateManager.updateTree(getRepoPath(), tree.ticketId, {
        status: 'review', ...(prUrl ? { prUrl } : {}),
      });

      const action = prUrl
        ? await vscode.window.showInformationMessage(`Shipped! PR: ${prUrl}`, 'Open PR')
        : await vscode.window.showInformationMessage('Shipped!');
      if (action === 'Open PR' && prUrl) {
        vscode.env.openExternal(vscode.Uri.parse(prUrl));
      }
    },
  );
}
