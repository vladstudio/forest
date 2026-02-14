import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager } from '../state';
import * as linear from '../cli/linear';
import { IssueItem } from './items';
import { getRepoPath } from '../context';

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssueItem> {
  private _onDidChange = new vscode.EventEmitter<IssueItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private issues: linear.LinearIssue[] = [];
  private lastFetch = 0;
  private readonly TTL = 60_000;

  constructor(private config: ForestConfig, private stateManager: StateManager) {}

  refresh(): void { this.lastFetch = 0; this._onDidChange.fire(undefined); }

  async getChildren(): Promise<IssueItem[]> {
    if (!this.config.integrations.linear || !(await linear.isAvailable())) return [];
    if (Date.now() - this.lastFetch > this.TTL) {
      this.issues = await linear.listMyIssues(this.config.linearStatuses.issueList, this.config.integrations.linearTeam);
      this.lastFetch = Date.now();
    }
    const state = await this.stateManager.load();
    const existing = new Set(this.stateManager.getTreesForRepo(state, getRepoPath()).map(t => t.ticketId));
    return this.issues.filter(i => !existing.has(i.id)).map(i => new IssueItem(i));
  }

  getTreeItem(el: IssueItem): vscode.TreeItem { return el; }
}
