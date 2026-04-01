import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import { getRepoPath } from '../context';
import { execShell } from '../utils/exec';
import { ensureWorkspaceFile, focusOrOpenWindow } from './shared';
import { notify } from '../notify';

export async function switchTree(ctx: ForestContext, branchArg?: string): Promise<void> {
  let branch = branchArg;
  const state = await ctx.stateManager.load();

  if (!branch) {
    const trees = ctx.stateManager.getTreesForRepo(state, getRepoPath()).filter(t => t.path);
    if (!trees.length) { notify.info('No trees to switch to.'); return; }
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { id: string }>(
      trees.map(t => ({ label: displayName(t), description: t.branch, id: t.branch })),
      { placeHolder: 'Select a tree' },
    );
    if (!pick) return;
    branch = pick.id;
  }

  const tree = ctx.stateManager.getTree(state, getRepoPath(), branch!);
  if (!tree) { notify.error(`Tree for branch "${branch}" not found.`); return; }
  if (!tree.path) { notify.error('Tree has no worktree path.'); return; }

  // Auto-allow direnv if .envrc exists
  if (fs.existsSync(path.join(tree.path, '.envrc'))) {
    try { await execShell('direnv allow', { cwd: tree.path, timeout: 10_000 }); } catch {}
  }

  const wsFile = ensureWorkspaceFile(tree);
  await focusOrOpenWindow(vscode.Uri.file(wsFile));
}
