import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { updateLinear } from './shared';

export async function ship(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) {
    vscode.window.showErrorMessage('Ship must be run from a tree window.');
    return;
  }
  const config = ctx.config;

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

      // Create PR
      let prUrl: string | null = null;
      progress.report({ message: 'Creating PR...' });
      if (config.linear.enabled && await linear.isAvailable()) {
        prUrl = await linear.createPR(tree.ticketId, config.baseBranch, tree.path);
        await updateLinear(ctx, tree.ticketId, config.linear.statuses.onShip);
      } else if (config.github.enabled && await gh.isAvailable()) {
        prUrl = await gh.createPR(tree.path, config.baseBranch, `${tree.ticketId}: ${tree.title}`);
      }

      // Update state
      if (prUrl) {
        await ctx.stateManager.updateTree(tree.repoPath, tree.ticketId, { prUrl });
      }

      const action = prUrl
        ? await vscode.window.showInformationMessage(`Shipped! PR: ${prUrl}`, 'Open PR')
        : await vscode.window.showInformationMessage('Shipped!');
      if (action === 'Open PR' && prUrl) {
        vscode.env.openExternal(vscode.Uri.parse(prUrl));
      }
    },
  );
}
