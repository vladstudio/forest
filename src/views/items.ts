import * as vscode from 'vscode';
import * as path from 'path';
import type { LinearIssue } from '../cli/linear';
import type { TreeState } from '../state';
import type { ShortcutConfig } from '../config';
import { displayName } from '../state';
import type { TreeHealth } from './ForestTreeProvider';

export class MainRepoItem extends vscode.TreeItem {
  contextValue = 'mainRepo';
  constructor(repoPath: string, baseBranch: string) {
    const branch = baseBranch.replace(/^origin\//, '');
    super(branch, vscode.TreeItemCollapsibleState.None);
    this.description = path.basename(repoPath);
    this.iconPath = new vscode.ThemeIcon('home');
    this.command = { command: 'forest.openMain', title: 'Open Main Repo' };
  }
}

export class StageGroupItem extends vscode.TreeItem {
  contextValue = 'stageGroup';
  constructor(label: string, count: number, icon: string, public readonly children: vscode.TreeItem[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class IssueItem extends vscode.TreeItem {
  contextValue = 'inbox-issue';
  constructor(public readonly issue: LinearIssue) {
    super(`${issue.id}  ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${issue.id}: ${issue.title}\nState: ${issue.state}`;
    this.iconPath = new vscode.ThemeIcon('circle-outline');
    this.command = { command: 'forest.start', title: 'Start', arguments: [{ ticketId: issue.id, title: issue.title }] };
  }
}

type ShortcutState = 'running' | 'stopped' | 'idle';

export class ShortcutItem extends vscode.TreeItem {
  constructor(public readonly shortcut: ShortcutConfig, state: ShortcutState) {
    super(shortcut.name, vscode.TreeItemCollapsibleState.None);

    if (shortcut.type === 'terminal') {
      const running = state === 'running';
      const mode = shortcut.mode ?? 'single-tree';
      this.contextValue = running
        ? (mode === 'multiple' ? 'shortcut-terminal-multi' : 'shortcut-terminal-running')
        : 'shortcut-terminal-stopped';
      this.iconPath = new vscode.ThemeIcon(
        'terminal',
        running ? new vscode.ThemeColor('charts.green') : undefined,
      );
      if (running && mode !== 'multiple') this.description = 'running';
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

export type TreeContext = 'tree-progress' | 'tree-shelved' | 'tree-review' | 'tree-done';

export class TreeItemView extends vscode.TreeItem {
  constructor(
    public readonly tree: TreeState,
    isCurrent: boolean,
    ctx: TreeContext,
    health?: TreeHealth,
  ) {
    super(displayName(tree), vscode.TreeItemCollapsibleState.None);

    const parts: string[] = [];
    if (health) {
      if (health.pr) {
        const rd = health.pr.reviewDecision;
        const prNum = health.pr.number ? `#${health.pr.number}` : 'PR';
        if (health.pr.state === 'MERGED') {
          parts.push(`${prNum} merged`);
        } else {
          const status = rd === 'APPROVED' ? 'approved' : rd === 'CHANGES_REQUESTED' ? 'changes' : health.pr.state.toLowerCase();
          parts.push(`${prNum} ${status}`);
        }
      }
      if (health.behind > 0) parts.push(`${health.behind}\u2193`);
      if (health.age) parts.push(abbreviateAge(health.age));
    }
    if (ctx === 'tree-shelved') parts.push('shelved');
    this.description = parts.join(' \u00b7 ');

    if (ctx === 'tree-shelved') {
      this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('disabledForeground'));
    } else if (isCurrent) {
      this.iconPath = new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('git-branch');
    }

    this.tooltip = [
      displayName(tree),
      `Branch: ${tree.branch}`,
      tree.path ? `Path: ${tree.path}` : 'Shelved (no worktree)',
      tree.prUrl ? `PR: ${tree.prUrl}` : undefined,
      tree.ticketId ? `Ticket: ${tree.ticketId}` : undefined,
    ].filter(Boolean).join('\n');

    this.contextValue = ctx;

    if (!isCurrent && tree.path) {
      this.command = { command: 'forest.switch', title: 'Switch', arguments: [tree.branch] };
    }
  }
}
