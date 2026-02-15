import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as linear from '../cli/linear';
import { createTree, updateLinear } from './shared';
import { getRepoPath } from '../context';

export async function newTree(ctx: ForestContext, arg?: string | { ticketId: string; title: string }): Promise<void> {
  let ticketId: string;
  let title: string | undefined;

  if (arg) {
    if (typeof arg === 'string') {
      ticketId = arg;
    } else {
      ticketId = arg.ticketId;
      title = arg.title;
    }
  } else if (ctx.config.linear.enabled && linear.isAvailable()) {
    const issues = await linear.listMyIssues(ctx.config.linear.statuses.issueList, ctx.config.linear.team);
    if (!issues.length) { vscode.window.showInformationMessage('No issues found.'); return; }
    const pick = await vscode.window.showQuickPick(
      issues.map(i => ({ label: `${i.id}  ${i.title}`, description: i.state, issueId: i.id, issueTitle: i.title })),
      { placeHolder: 'Select an issue' },
    ) as any;
    if (!pick) return;
    ticketId = pick.issueId;
    title = pick.issueTitle;
  } else {
    const input = await vscode.window.showInputBox({ prompt: 'Branch name', placeHolder: 'my-feature' });
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

  // Fetch title if not already known
  if (!title && ctx.config.linear.enabled && linear.isAvailable()) {
    const issue = await linear.getIssue(ticketId);
    title = issue?.title;
  }
  if (!title) {
    title = await vscode.window.showInputBox({ prompt: 'Title' });
    if (!title) return;
  }

  // Confirm before creating
  const linearAvailable = ctx.config.linear.enabled && linear.isAvailable();
  const confirmItems = [
    { label: `$(add) Create "${title}"`, id: 'create' },
    ...(linearAvailable ? [{ label: '$(link-external) Open in browser', id: 'open' }] : []),
    { label: '$(close) Cancel', id: 'cancel' },
  ];
  const confirm = await vscode.window.showQuickPick(confirmItems, { placeHolder: `Create tree for ${ticketId}?` });
  if (confirm?.id === 'open') {
    const url = await linear.getIssueUrl(ticketId);
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  if (confirm?.id !== 'create') return;

  try {
    await createTree({ ticketId, title, config: ctx.config, stateManager: ctx.stateManager, portManager: ctx.portManager });
    await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}
