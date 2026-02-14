import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as linear from '../cli/linear';
import { createTree, updateLinear } from './shared';
import { getRepoPath } from '../context';

export async function newTree(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  let ticketId: string;
  let title: string | undefined;

  if (ticketIdArg) {
    ticketId = ticketIdArg;
  } else if (ctx.config.linear.enabled && await linear.isAvailable()) {
    const issues = await linear.listMyIssues(ctx.config.linear.statuses.issueList, ctx.config.linear.team);
    if (!issues.length) { vscode.window.showInformationMessage('No issues found.'); return; }
    const pick = await vscode.window.showQuickPick(
      issues.map(i => ({ label: `${i.id}  ${i.title}`, description: i.state, issueId: i.id })),
      { placeHolder: 'Select an issue' },
    ) as any;
    if (!pick) return;
    ticketId = pick.issueId;
  } else {
    const input = await vscode.window.showInputBox({ prompt: 'Ticket ID', placeHolder: 'TEAM-1234' });
    if (!input) return;
    ticketId = input;
  }

  // Check if tree already exists
  const state = await ctx.stateManager.load();
  const existing = ctx.stateManager.getTree(state, getRepoPath(), ticketId);
  if (existing) {
    const choice = await vscode.window.showWarningMessage(
      `Tree for ${ticketId} already exists.`, 'Switch to it', 'Cancel',
    );
    if (choice === 'Switch to it') {
      await vscode.commands.executeCommand('forest.switch', ticketId);
    }
    return;
  }

  // Fetch title
  if (!title && ctx.config.linear.enabled && await linear.isAvailable()) {
    const issue = await linear.getIssue(ticketId);
    title = issue?.title;
  }
  if (!title) {
    title = await vscode.window.showInputBox({ prompt: 'Issue title' });
    if (!title) return;
  }

  try {
    await createTree({ ticketId, title, config: ctx.config, stateManager: ctx.stateManager, portManager: ctx.portManager });
    await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}
