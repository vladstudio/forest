import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager } from '../state';
import * as linear from '../cli/linear';
import { IssueItem, StatusGroupItem } from './items';
import { getRepoPath } from '../context';

type IssueTreeNode = StatusGroupItem | IssueItem;

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssueTreeNode> {
  private _onDidChange = new vscode.EventEmitter<IssueTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private issues: linear.LinearIssue[] = [];
  private lastFetch = 0;
  private readonly TTL = 60_000;

  constructor(private config: ForestConfig, private stateManager: StateManager) {}

  refresh(): void { this.lastFetch = 0; this._onDidChange.fire(undefined); }

  getTreeItem(el: IssueTreeNode): vscode.TreeItem { return el; }

  async getChildren(element?: IssueTreeNode): Promise<IssueTreeNode[]> {
    if (!this.config.linear.enabled || !(await linear.isAvailable())) return [];

    if (Date.now() - this.lastFetch > this.TTL) {
      this.issues = await linear.listMyIssues(this.config.linear.statuses.issueList, this.config.linear.team);
      this.lastFetch = Date.now();
    }

    const state = await this.stateManager.load();
    const existing = new Set(this.stateManager.getTreesForRepo(state, getRepoPath()).map(t => t.ticketId));
    const filtered = this.issues.filter(i => !existing.has(i.id));

    if (!element) {
      // Group by status, ordered by config
      const grouped = new Map<string, linear.LinearIssue[]>();
      for (const issue of filtered) {
        const key = issue.state.toLowerCase();
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(issue);
      }

      // Only one group → show flat list
      if (grouped.size <= 1) return filtered.map(i => new IssueItem(i));

      // Order groups by config order, then any extras
      // Map CLI state names to display names used by `linear issue list`
      const displayName: Record<string, string> = {
        triage: 'triage', backlog: 'backlog', unstarted: 'todo',
        started: 'in progress', completed: 'done', canceled: 'canceled',
      };
      const order = this.config.linear.statuses.issueList.map(s => displayName[s.toLowerCase()] || s.toLowerCase());
      const sorted = [...grouped.keys()].sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
      return sorted.map(s => new StatusGroupItem(grouped.get(s)![0].state, grouped.get(s)!.length));
    }

    if (element instanceof StatusGroupItem) {
      const key = element.status.toLowerCase();
      return filtered.filter(i => i.state.toLowerCase() === key).map(i => new IssueItem(i));
    }

    return [];
  }
}
