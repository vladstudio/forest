import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { pickIssue, createIssue } from './create';
import { updateLinear } from './shared';

export async function linkTicket(ctx: ForestContext, branch: string): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    { label: 'Link to existing Linear issue', id: 'select' },
    { label: 'Create new Linear issue', id: 'create' },
  ], { placeHolder: 'Attach a Linear ticket' });
  if (!choice) return;

  let ticketId: string | undefined;
  let title: string | undefined;

  if (choice.id === 'select') {
    const result = await pickIssue(ctx);
    if (!result) return;
    ticketId = result.ticketId;
    title = result.title;
  } else {
    const result = await createIssue(ctx);
    if (!result) return;
    ticketId = result.ticketId;
    title = result.title;
  }

  await ctx.stateManager.updateTree(ctx.repoPath, branch, { ticketId, title });
  await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
}
