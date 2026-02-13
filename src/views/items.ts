import * as vscode from 'vscode';
import type { LinearIssue } from '../cli/linear';
import type { TreeState } from '../state';

export class IssueItem extends vscode.TreeItem {
  contextValue = 'issue';
  constructor(public readonly issue: LinearIssue) {
    super(`${issue.id}  ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `[${issue.state}]`;
    this.tooltip = `${issue.id}: ${issue.title}\nState: ${issue.state}`;
    this.iconPath = new vscode.ThemeIcon('circle-outline');
    this.command = { command: 'forest.plant', title: 'Plant Tree', arguments: [issue.id] };
  }
}

export class TreeItemView extends vscode.TreeItem {
  contextValue = 'tree';
  constructor(public readonly tree: TreeState, isCurrent: boolean) {
    super(`${tree.ticketId}  ${tree.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `[${tree.status}]`;
    this.iconPath = isCurrent
      ? new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('git-branch');
    this.tooltip = [
      `${tree.ticketId}: ${tree.title}`,
      `Branch: ${tree.branch}`,
      `Status: ${tree.status}`,
      `Ports: ${tree.portBase}`,
      tree.prUrl ? `PR: ${tree.prUrl}` : 'PR: none',
    ].join('\n');
    if (!isCurrent) {
      this.command = { command: 'forest.switch', title: 'Switch', arguments: [tree.ticketId] };
    }
  }
}
