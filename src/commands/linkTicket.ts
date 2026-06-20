import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { notify } from '../notify';
import { duplicateTicketMessage } from '../state';
import { pickIssue, createIssue } from './create';
import { updateLinear } from './shared';

export async function linkTicket(ctx: ForestContext, branch: string, mode?: 'select' | 'create'): Promise<void> {
  let resolved = mode;
  if (!resolved) {
    const choice = await vscode.window.showQuickPick([
      { label: 'Link to existing Linear issue', id: 'select' as const },
      { label: 'Create new Linear issue', id: 'create' as const },
    ], { placeHolder: 'Attach a Linear ticket' });
    if (!choice) return;
    resolved = choice.id;
  }

  let ticketId: string | undefined;
  let title: string | undefined;

  if (resolved === 'select') {
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

  const state = await ctx.stateManager.load();
  // Same ticket on same branch: no-op, not an error.
  const existing = ctx.stateManager.findTreeByTicket(state, ctx.repoPath, ticketId!, {
    excludeBranch: branch,
  });
  if (existing) {
    notify.error(duplicateTicketMessage(ticketId!, existing));
    return;
  }

  await ctx.stateManager.updateTree(ctx.repoPath, branch, { ticketId, title });
  await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
}
