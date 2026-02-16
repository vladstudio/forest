import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { displayName } from '../state';
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
  if (!tree.path) {
    vscode.window.showErrorMessage('Cannot ship a shelved tree. Resume it first.');
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

  const name = displayName(tree);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shipping ${name}...` },
    async (progress) => {
      // Push
      progress.report({ message: 'Pushing branch...' });
      await git.pushBranch(tree.path!, tree.branch);

      // Create PR via gh CLI
      let prUrl: string | null = null;
      if (config.github.enabled && await gh.isAvailable()) {
        progress.report({ message: 'Creating PR...' });
        const prTitle = tree.ticketId && tree.title
          ? `${tree.ticketId}: ${tree.title}`
          : name;
        prUrl = await gh.createPR(tree.path!, config.baseBranch, prTitle);
      }

      // Update Linear status
      if (tree.ticketId && config.linear.enabled && linear.isAvailable()) {
        progress.report({ message: 'Updating Linear...' });
        await updateLinear(ctx, tree.ticketId, config.linear.statuses.onShip);
      }

      // Update state
      if (prUrl) {
        await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl });
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
