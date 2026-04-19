import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { ForestState, StateManager } from '../state';
import { getTreesDir } from '../config';
import { deleteWorkspaceFiles } from '../commands/shared';

export async function initializeState(ctx: ForestContext): Promise<ForestState> {
  const { stateManager, repoPath, outputChannel } = ctx;

  await stateManager.initialize();

  // Clear stale cleaning flags from crashed teardowns
  await stateManager.clearStaleTreeOperations(repoPath);
  const s = await stateManager.load();
  for (const tree of stateManager.getTreesForRepo(s, repoPath)) {
    if (tree.cleaning && tree.path && fs.existsSync(tree.path)) {
      await stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
    }
  }

  // Prune orphans, then recover
  const afterPrune = await pruneOrphans(stateManager, repoPath, outputChannel);
  return recoverOrphanWorktrees(stateManager, repoPath, outputChannel, afterPrune);
}

export async function pruneOrphans(stateManager: StateManager, repoPath: string, outputChannel: import('vscode').OutputChannel): Promise<ForestState> {
  // Clean up stale .removing directories from interrupted deletions
  const treesDir = getTreesDir(repoPath);
  if (fs.existsSync(treesDir)) {
    for (const entry of fs.readdirSync(treesDir)) {
      if (entry.includes('.removing.')) {
        await fs.promises.rm(path.join(treesDir, entry), { recursive: true, force: true }).catch(() => { });
      }
    }
  }
  const s = await stateManager.load();
  const trees = stateManager.getTreesForRepo(s, repoPath);
  for (const tree of trees) {
    if (tree.path && !fs.existsSync(tree.path)) {
      outputChannel.appendLine(`[Forest] Pruning orphan: ${tree.branch} (${tree.path} missing)`);
      await stateManager.removeTree(tree.repoPath, tree.branch);
      deleteWorkspaceFiles(tree);
    }
  }
  return stateManager.load();
}

async function recoverOrphanWorktrees(
  stateManager: StateManager,
  repoPath: string,
  outputChannel: import('vscode').OutputChannel,
  state: ForestState,
): Promise<ForestState> {
  const treesDir = getTreesDir(repoPath);
  if (!fs.existsSync(treesDir)) return state;
  const knownPaths = new Set(
    stateManager.getTreesForRepo(state, repoPath).map(t => t.path).filter(Boolean),
  );
  for (const entry of fs.readdirSync(treesDir)) {
    if (entry.startsWith('.')) continue;
    const dirPath = path.join(treesDir, entry);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    if (knownPaths.has(dirPath)) continue;
    // Check if it's a valid git worktree
    const gitFile = path.join(dirPath, '.git');
    if (!fs.existsSync(gitFile)) continue;
    try {
      // Read branch from git worktree HEAD
      const gitContent = fs.readFileSync(gitFile, 'utf8').trim();
      const gitdir = path.resolve(dirPath, gitContent.replace('gitdir: ', ''));
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      const branch = head.startsWith('ref: refs/heads/') ? head.replace('ref: refs/heads/', '') : '';
      if (!branch) continue;
      outputChannel.appendLine(`[Forest] Recovered orphan worktree: ${branch} at ${dirPath}`);
      await stateManager.addTree(repoPath, {
        branch, repoPath, path: dirPath,
        createdAt: new Date(fs.statSync(dirPath).birthtimeMs).toISOString(),
      });
    } catch { /* not a valid worktree, skip */ }
  }
  return stateManager.load();
}
