import * as vscode from 'vscode';
import * as path from 'path';
import type { ForestContext } from '../context';
import { getRepoPath } from '../context';

export async function switchTree(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  let ticketId = ticketIdArg;

  if (!ticketId) {
    const state = await ctx.stateManager.load();
    const trees = ctx.stateManager.getTreesForRepo(state, getRepoPath());
    if (!trees.length) { vscode.window.showInformationMessage('No trees to switch to.'); return; }
    const pick = await vscode.window.showQuickPick(
      trees.map(t => ({ label: `${t.ticketId}  ${t.title}`, description: `[${t.status}]`, id: t.ticketId })),
      { placeHolder: 'Select a tree' },
    ) as any;
    if (!pick) return;
    ticketId = pick.id;
  }

  const state = await ctx.stateManager.load();
  const tree = ctx.stateManager.getTree(state, getRepoPath(), ticketId!);
  if (!tree) { vscode.window.showErrorMessage(`Tree ${ticketId} not found.`); return; }

  const wsFile = path.join(tree.path, `${tree.ticketId}.code-workspace`);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });
}
