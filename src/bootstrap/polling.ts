import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { ForestState } from '../state';
import * as gh from '../cli/gh';
import { cleanupMerged } from '../commands/cleanup';

/** setInterval with a guard flag to prevent overlapping runs. */
function guardedInterval(fn: () => Promise<void>, ms: number): vscode.Disposable {
  let running = false;
  const id = setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch { /* guarded */ } finally { running = false; }
  }, ms);
  return { dispose: () => clearInterval(id) };
}

export function startPolling(ctx: ForestContext, pruneOrphansFn: () => Promise<ForestState>): vscode.Disposable[] {
  const { stateManager, repoPath, config, forestProvider, currentTree } = ctx;
  const disposables: vscode.Disposable[] = [];

  // Auto-cleanup: check merged PRs every 5 minutes
  // Only notify in the tree's own window or the main (non-tree) window.
  disposables.push(guardedInterval(async () => {
    if (!(await gh.isAvailable())) return;
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, repoPath);
    const candidates = trees.filter(tree => {
      if (!tree.prUrl || !tree.path || tree.mergeNotified) return false;
      return ctx.currentTree?.branch === tree.branch || !ctx.currentTree;
    });
    if (!candidates.length) return;
    const mergedResults = await Promise.allSettled(
      candidates.map(tree => gh.prIsMerged(tree.repoPath, tree.branch).then(merged => ({ tree, merged }))),
    );
    for (const result of mergedResults) {
      if (result.status !== 'fulfilled' || !result.value.merged) continue;
      const tree = result.value.tree;
      const isOwnWindow = ctx.currentTree?.branch === tree.branch;
      await stateManager.updateTree(tree.repoPath, tree.branch, { mergeNotified: true });
      const name = tree.ticketId ?? tree.branch;
      const detail = [tree.ticketId && config.linear.enabled && `move ${tree.ticketId} → ${config.linear.statuses.onCleanup}`, 'remove worktree + branch', isOwnWindow && 'close window'].filter(Boolean).join(', ');
      const action = await vscode.window.showInformationMessage(
        `${name} PR was merged. Cleanup will ${detail}.`,
        'Cleanup', 'Dismiss',
      );
      if (action === 'Cleanup') await cleanupMerged(ctx, tree);
    }
  }, 5 * 60 * 1000));

  // Orphan check every 60 seconds
  disposables.push(guardedInterval(async () => {
    const before = stateManager.getTreesForRepo(await stateManager.load(), repoPath).length;
    const afterState = await pruneOrphansFn();
    const after = stateManager.getTreesForRepo(afterState, repoPath).length;
    if (after < before) forestProvider.refresh();
  }, 60_000));

  // Health refresh every 3 minutes
  const healthId = setInterval(() => forestProvider.refreshTrees(), 3 * 60 * 1000);
  disposables.push({ dispose: () => clearInterval(healthId) });

  return disposables;
}
