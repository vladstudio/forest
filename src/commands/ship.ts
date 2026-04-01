import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';

import { generatePRBody } from '../cli/ai';
import { requireTree, updateLinear, withTreeOperation } from './shared';
import { log } from '../logger';
import { notify } from '../notify';


export async function ship(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = requireTree(ctx, treeArg, 'ship');
  log.info(`ship: ${tree?.branch ?? '(no tree)'} ticket=${tree?.ticketId ?? '(none)'}`);
  if (!tree) return;
  const config = ctx.config;

  // Check uncommitted changes
  if (await git.hasUncommittedChanges(tree.path)) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
    );
    if (choice !== 'Ship Anyway') return;
  }

  const ghEnabled = config.github.enabled && await gh.isAvailable();

  // Show picker with automerge option when supported
  let automerge = false;
  if (ghEnabled) {
    const hasAutomerge = await gh.repoHasAutomerge(tree.path);
    if (hasAutomerge) {
      const pick = await vscode.window.showQuickPick(
        ['Create PR + Automerge', 'Create PR'],
        { placeHolder: 'Ship — Push & Create PR...' },
      );
      if (!pick) return;
      automerge = pick === 'Create PR + Automerge';
    }
  }

  const name = displayName(tree);
  const prUrl = await withTreeOperation(
    ctx,
    tree,
    'shipping',
    () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Shipping ${name}...` },
      async (progress) => {
        // Start push and diff generation in parallel (diff is local, push is network)
        progress.report({ message: 'Pushing branch...' });
        const pushPromise = git.pushBranch(tree.path!, tree.branch);
        const prStatusPromise = ghEnabled && !tree.prUrl ? gh.prStatus(tree.path!) : Promise.resolve(null);
        const diffPromise = config.ai ? git.diffFromBase(tree.path!, config.baseBranch) : Promise.resolve(null);

        let url: string | null = null;
        if (ghEnabled) {
          if (tree.prUrl) {
            url = tree.prUrl;
          } else {
            const existing = await prStatusPromise;
            if (existing?.url) {
              url = existing.url;
            } else {
              const prTitle = tree.ticketId && tree.title
                ? `${tree.ticketId}: ${tree.title}`
                : name;

              let prBody: string | undefined;
              if (config.ai) {
                try {
                  progress.report({ message: 'Generating PR description...' });
                  const diff = await diffPromise ?? '';
                  prBody = await generatePRBody(config.ai, diff, prTitle);
                } catch (e: any) {
                  log.error(`AI PR body generation failed: ${e.message}`);
                  notify.warn(`AI description failed, using commits. ${e.message}`);
                }
              }

              // Ensure push is done before creating PR
              await pushPromise;
              progress.report({ message: 'Creating PR...' });
              url = await gh.createPR(tree.path!, config.baseBranch, prTitle, prBody);
            }
          }
        }

        // Always ensure push completes (no-op if already awaited above)
        await pushPromise;
        return url;
      },
    ),
  );
  if (prUrl === undefined) return;

  if (prUrl) {
    notify.info(`Shipped! PR: ${prUrl}`);
    vscode.env.openExternal(vscode.Uri.parse(prUrl));
  } else {
    notify.info('Shipped!');
  }

  // Post-ship: automerge, Linear update, state save — all independent, run in parallel
  const postShip: Promise<void>[] = [];

  if (prUrl && automerge) {
    postShip.push(gh.enableAutomerge(tree.path!));
  }

  if (tree.ticketId) {
    postShip.push(updateLinear(ctx, tree.ticketId, config.linear.statuses.onShip));
  }

  if (prUrl) {
    postShip.push(ctx.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl }));
  }

  const results = await Promise.allSettled(postShip);
  for (const r of results) if (r.status === 'rejected') {
    const msg = r.reason?.message ?? String(r.reason);
    log.error(`Post-ship task failed: ${msg}`);
    notify.warn(`Post-ship task failed: ${msg}`);
  }
}
