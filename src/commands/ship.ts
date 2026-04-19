import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';

import { generatePRBody } from '../cli/ai';
import { requireTree, updateLinear, withTreeOperation } from './shared';
import { notify } from '../notify';

/** Core shipping logic: push + create PR + post-ship tasks. No UI wrappers. */
export async function shipCore(
  ctx: ForestContext,
  tree: TreeState & { path: string },
  automerge: boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  const config = ctx.config;
  const name = displayName(tree);
  const ghEnabled = config.github.enabled && await gh.isAvailable();

  const pushPromise = git.pushBranch(tree.path, tree.branch, { signal });
  const prStatusPromise = ghEnabled && !tree.prUrl ? gh.prStatus(tree.path) : Promise.resolve(null);
  const diffPromise = config.ai ? git.diffFromBase(tree.path, config.baseBranch, { signal }) : Promise.resolve(null);

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
            const diff = await diffPromise ?? '';
            prBody = await generatePRBody(config.ai, diff, prTitle, { signal });
          } catch (e: any) {
            if (signal?.aborted) throw e;
            notify.warn(`AI description failed, using commits. ${e.message}`);
          }
        }

        await pushPromise;
        url = await gh.createPR(tree.path, config.baseBranch, prTitle, prBody, { signal });
      }
    }
  }

  await pushPromise;

  // Post-ship: automerge, Linear update, state save — all independent
  const postShip: Promise<void>[] = [];
  if (url && automerge) postShip.push(gh.enableAutomerge(tree.path, { signal }));
  if (tree.ticketId) postShip.push(updateLinear(ctx, tree.ticketId, config.linear.statuses.onShip));
  if (url) postShip.push(ctx.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: url }));

  const results = await Promise.allSettled(postShip);
  for (const r of results) if (r.status === 'rejected') {
    const msg = r.reason?.message ?? String(r.reason);
    notify.warn(`Post-ship task failed: ${msg}`);
  }

  return url;
}

export async function ship(ctx: ForestContext, treeArg: TreeState | undefined, automerge: boolean): Promise<void> {
  const tree = await requireTree(ctx, treeArg, 'ship');
  if (!tree) return;

  if (await git.hasUncommittedChanges(tree.path)) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
    );
    if (choice !== 'Ship Anyway') return;
  }

  const name = displayName(tree);
  const prUrl = await withTreeOperation(
    ctx,
    tree,
    'shipping',
    () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Shipping ${name}...` },
      () => shipCore(ctx, tree, automerge),
    ),
  );
  if (prUrl === undefined) return;

  if (prUrl) {
    notify.info(`Shipped! PR: ${prUrl}`);
    vscode.env.openExternal(vscode.Uri.parse(prUrl));
  } else {
    notify.info('Shipped!');
  }
}
