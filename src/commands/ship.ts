import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { generatePRBody } from '../cli/ai';
import { updateLinear } from './shared';
import { log } from '../logger';


export async function ship(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  log.info(`ship: ${tree?.branch ?? '(no tree)'} ticket=${tree?.ticketId ?? '(none)'}`);
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
  const prUrl = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shipping ${name}...` },
    async (progress) => {
      // Push
      progress.report({ message: 'Pushing branch...' });
      await git.pushBranch(tree.path!, tree.branch);

      // Create PR via gh CLI
      let url: string | null = null;
      if (config.github.enabled && await gh.isAvailable()) {
        const prTitle = tree.ticketId && tree.title
          ? `${tree.ticketId}: ${tree.title}`
          : name;

        let prBody: string | undefined;
        if (config.ai) {
          try {
            progress.report({ message: 'Generating PR description...' });
            const diff = await git.diffFromBase(tree.path!, config.baseBranch);
            prBody = await generatePRBody(config.ai, diff, prTitle);
          } catch (e: any) {
            log.error(`AI PR body generation failed: ${e.message}`);
            vscode.window.showWarningMessage(`AI description failed, using commits. ${e.message}`);
          }
        }

        progress.report({ message: 'Creating PR...' });
        url = await gh.createPR(tree.path!, config.baseBranch, prTitle, prBody);
      }

      // Update Linear status
      if (tree.ticketId && config.linear.enabled && linear.isAvailable()) {
        progress.report({ message: 'Updating Linear...' });
        await updateLinear(ctx, tree.ticketId, config.linear.statuses.onShip);
      }

      // Update state
      if (url) {
        await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: url });
      }

      return url;
    },
  );

  if (prUrl) {
    vscode.window.showInformationMessage(`Shipped! PR: ${prUrl}`);
    vscode.env.openExternal(vscode.Uri.parse(prUrl));
  } else {
    vscode.window.showInformationMessage('Shipped!');
  }
}
