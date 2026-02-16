import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import { getRepoPath } from '../context';
import { execShell } from '../utils/exec';
import { workspaceFilePath } from './shared';

export async function switchTree(ctx: ForestContext, branchArg?: string): Promise<void> {
  let branch = branchArg;

  if (!branch) {
    const state = await ctx.stateManager.load();
    const trees = ctx.stateManager.getTreesForRepo(state, getRepoPath()).filter(t => t.path);
    if (!trees.length) { vscode.window.showInformationMessage('No trees to switch to.'); return; }
    const pick = await vscode.window.showQuickPick(
      trees.map(t => ({ label: displayName(t), description: t.branch, id: t.branch })),
      { placeHolder: 'Select a tree' },
    ) as any;
    if (!pick) return;
    branch = pick.id;
  }

  const state = await ctx.stateManager.load();
  const tree = ctx.stateManager.getTree(state, getRepoPath(), branch!);
  if (!tree) { vscode.window.showErrorMessage(`Tree for branch "${branch}" not found.`); return; }
  if (!tree.path) { vscode.window.showErrorMessage('Tree is shelved. Resume it first.'); return; }

  // Auto-allow direnv if .envrc exists
  if (fs.existsSync(path.join(tree.path, '.envrc'))) {
    try { await execShell('direnv allow', { cwd: tree.path, timeout: 10_000 }); } catch {}
  }

  const wsFile = workspaceFilePath(getRepoPath(), tree.branch);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });
}
