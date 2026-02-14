import * as vscode from 'vscode';
import type { LinearIssue } from '../cli/linear';
import type { TreeState } from '../state';
import type { ShortcutConfig } from '../config';
import type { TreeHealth } from './TreesTreeProvider';

export class StatusGroupItem extends vscode.TreeItem {
  contextValue = 'statusGroup';
  constructor(public readonly status: string, count: number) {
    super(status, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon('circle-outline');
  }
}

export class TreeGroupItem extends vscode.TreeItem {
  contextValue = 'treeGroup';
  constructor(label: string, public readonly trees: TreeItemView[], icon: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${trees.length}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class IssueItem extends vscode.TreeItem {
  contextValue = 'issue';
  constructor(public readonly issue: LinearIssue) {
    super(`${issue.id}  ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${issue.id}: ${issue.title}\nState: ${issue.state}`;
    this.iconPath = new vscode.ThemeIcon('circle-outline');
    this.command = { command: 'forest.newTree', title: 'New Tree', arguments: [issue.id] };
  }
}

type ShortcutState = 'running' | 'stopped' | 'idle';

export class ShortcutItem extends vscode.TreeItem {
  constructor(public readonly shortcut: ShortcutConfig, state: ShortcutState) {
    super(shortcut.name, vscode.TreeItemCollapsibleState.None);

    if (shortcut.type === 'terminal') {
      const running = state === 'running';
      this.contextValue = running
        ? (shortcut.allowMultiple ? 'shortcut-terminal-multi' : 'shortcut-terminal-running')
        : 'shortcut-terminal-stopped';
      this.iconPath = new vscode.ThemeIcon(
        'terminal',
        running ? new vscode.ThemeColor('charts.green') : undefined,
      );
      if (running && !shortcut.allowMultiple) this.description = 'running';
    } else if (shortcut.type === 'browser') {
      this.contextValue = 'shortcut-browser';
      this.iconPath = new vscode.ThemeIcon('globe');
    } else {
      this.contextValue = 'shortcut-file';
      this.iconPath = new vscode.ThemeIcon('file');
    }

    this.command = { command: 'forest.openShortcut', title: 'Open', arguments: [shortcut] };
  }
}

function abbreviateAge(age: string): string {
  return age
    .replace(/ seconds? ago/, 's')
    .replace(/ minutes? ago/, 'm')
    .replace(/ hours? ago/, 'h')
    .replace(/ days? ago/, 'd')
    .replace(/ weeks? ago/, 'w')
    .replace(/ months? ago/, 'mo')
    .replace(/ years? ago/, 'y');
}

export class TreeItemView extends vscode.TreeItem {
  contextValue = 'tree';
  constructor(public readonly tree: TreeState, isCurrent: boolean, health?: TreeHealth) {
    super(`${tree.ticketId}  ${tree.title}`, vscode.TreeItemCollapsibleState.None);

    const parts: string[] = [`[${tree.status}]`];
    if (health) {
      if (health.pr) {
        const rd = health.pr.reviewDecision;
        const prLabel = rd === 'APPROVED' ? 'PR approved' : rd === 'CHANGES_REQUESTED' ? 'PR changes' : `PR ${health.pr.state.toLowerCase()}`;
        parts.push(prLabel);
      }
      if (health.behind > 0) parts.push(`${health.behind}\u2193`);
      if (health.age !== 'unknown') parts.push(abbreviateAge(health.age));
    }
    this.description = parts.join(' \u00b7 ');

    const statusColor: Record<string, string> = {
      dev: 'charts.blue',
      testing: 'charts.yellow',
      review: 'charts.orange',
      done: 'charts.green',
    };
    const color = statusColor[tree.status] ? new vscode.ThemeColor(statusColor[tree.status]) : undefined;
    this.iconPath = isCurrent
      ? new vscode.ThemeIcon('arrow-right', color ?? new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('git-branch', color);
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
