import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';

import { generatePRBody } from '../cli/ai';
import { resolveTetraConfig } from '../config';
import { requireTree, updateLinear, withTreeOperation } from './shared';
import { notify } from '../notify';

export function prTitleForTree(tree: TreeState): string {
  return tree.ticketId && tree.title ? `${tree.ticketId}: ${tree.title}` : displayName(tree);
}

export async function generatePRDraft(
  ctx: ForestContext,
  tree: TreeState & { path: string },
  signal?: AbortSignal,
): Promise<{ title: string; body: string }> {
  const title = prTitleForTree(tree);
  if (ctx.config.tetra) {
    const tetra = resolveTetraConfig(ctx.config.tetra);
    try {
      const diff = await git.diffFromBase(tree.path, ctx.config.baseBranch, { signal });
      return { title, body: await generatePRBody(tetra, diff, title, { signal }) };
    } catch (e: any) {
      if (signal?.aborted) throw e;
    }
  }

  const subjects = await git.commitSubjectsFromBase(tree.path, ctx.config.baseBranch, { signal });
  return { title, body: subjects.length ? subjects.map(s => `- ${s}`).join('\n') : '' };
}

/** Core shipping logic: push + create PR + post-ship tasks. No UI wrappers. */
export async function shipCore(
  ctx: ForestContext,
  tree: TreeState & { path: string },
  automerge: boolean,
  signal?: AbortSignal,
  prBody?: string,
): Promise<string | null> {
  const config = ctx.config;
  const ghEnabled = config.github.enabled && await gh.isAvailable();

  const pushPromise = git.pushBranch(tree.path, tree.branch, { signal });
  const prStatusPromise = ghEnabled && !tree.prUrl
    ? gh.prStatus(tree.path).catch((e: any) => {
        ctx.outputChannel.appendLine(`[Forest] PR lookup failed for ${tree.branch}: ${e.message}`);
        return null;
      })
    : Promise.resolve(null);

  let url: string | null = null;
  if (ghEnabled) {
    if (tree.prUrl) {
      url = tree.prUrl;
    } else {
      const existing = await prStatusPromise;
      if (existing?.url) {
        url = existing.url;
      } else {
        const title = prTitleForTree(tree);
        let body = prBody;
        if (body === undefined && config.tetra) {
          const tetra = resolveTetraConfig(config.tetra);
          try {
            const diff = await git.diffFromBase(tree.path, config.baseBranch, { signal });
            body = await generatePRBody(tetra, diff, title, { signal });
          } catch (e: any) {
            if (signal?.aborted) throw e;
            notify.warn(`AI description failed, using gh fill. ${e.message}`);
          }
        }
        await pushPromise;
        url = await gh.createPR(tree.path, config.baseBranch, title, body, { signal });
      }
    }
  }

  await pushPromise;

  // Post-ship: automerge, Linear update, state save — all independent
  const postShip: Promise<void>[] = [];
  if (url && automerge) postShip.push(gh.enableAutomerge(tree.path, { signal }));
  if (tree.ticketId) {
    postShip.push((async () => {
      const ok = await updateLinear(ctx, tree.ticketId!, config.linear.statuses.onShip);
      if (!ok) throw new Error(`Linear ${tree.ticketId} → ${config.linear.statuses.onShip} failed`);
    })());
  }
  if (url) postShip.push(ctx.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: url }));

  const results = await Promise.allSettled(postShip);
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason?.message ?? String(r.reason));
  if (failures.length) {
    notify.warn(`${url ? 'PR created' : 'Ship succeeded'}, but follow-up steps failed: ${failures.join('; ')}`);
  }

  return url;
}

export async function ship(ctx: ForestContext, treeArg: TreeState | undefined, automerge: boolean): Promise<void> {
  const tree = requireTree(ctx, treeArg, 'ship');
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
