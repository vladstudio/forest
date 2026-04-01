import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import { getRepoPath } from '../context';
import { notify } from '../notify';

export async function list(ctx: ForestContext): Promise<void> {
  const state = await ctx.stateManager.load();
  const trees = ctx.stateManager.getTreesForRepo(state, getRepoPath()).filter(t => t.path);
  if (!trees.length) { notify.info('No trees yet.'); return; }

  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items = trees.map(t => ({
    label: `${t.path === curPath ? '$(star-full) ' : ''}${displayName(t)}`,
    description: t.branch,
    id: t.branch,
  }));

  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { id: string }>(items, { placeHolder: 'All trees' });
  if (pick) await vscode.commands.executeCommand('forest.switch', pick.id);
}
