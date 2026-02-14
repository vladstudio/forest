import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { getRepoPath } from '../context';

export async function list(ctx: ForestContext): Promise<void> {
  const state = await ctx.stateManager.load();
  const trees = ctx.stateManager.getTreesForRepo(state, getRepoPath());
  if (!trees.length) { vscode.window.showInformationMessage('No trees yet.'); return; }

  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items = trees.map(t => ({
    label: `${t.path === curPath ? '$(star-full) ' : ''}${t.ticketId}  ${t.title}`,
    description: `[${t.status}] :${t.portBase}`,
    id: t.ticketId,
  }));

  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'All trees' }) as any;
  if (pick) await vscode.commands.executeCommand('forest.switch', pick.id);
}
