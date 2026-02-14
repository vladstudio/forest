import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as linear from '../cli/linear';
import { createTree } from './shared';

export async function newIssueTree(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const title = await vscode.window.showInputBox({ prompt: 'Issue title', placeHolder: 'Fix team invite email validation' });
  if (!title) return;

  let ticketId: string;
  let issueTitle = title;

  if (config.linear.enabled && await linear.isAvailable()) {
    // Pick priority
    const priority = await vscode.window.showQuickPick(
      [{ label: 'Urgent', value: 1 }, { label: 'High', value: 2 }, { label: 'Normal', value: 3 }, { label: 'Low', value: 4 }],
      { placeHolder: 'Priority (optional — Enter to skip)' },
    ) as any;

    try {
      ticketId = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating Linear issue...', cancellable: false },
        async () => {
          const id = await linear.createIssue({ title, priority: priority?.value, team: config.linear.team });
          const issue = await linear.getIssue(id);
          if (issue) issueTitle = issue.title;
          return id;
        },
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to create Linear issue: ${e.message}`);
      return;
    }
  } else {
    // Manual mode
    const id = await vscode.window.showInputBox({ prompt: 'Ticket ID', placeHolder: 'TEAM-1234' });
    if (!id) return;
    ticketId = id;
  }

  try {
    await createTree({ ticketId, title: issueTitle, config, stateManager: ctx.stateManager, portManager: ctx.portManager });
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}
