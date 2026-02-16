import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager, TreeState } from '../state';
import { StageGroupItem, IssueItem, TreeItemView } from './items';
import type { TreeContext } from './items';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';

export interface TreeHealth {
  behind: number;
  age: string | null;
  pr: { state: string; reviewDecision: string | null; number?: number } | null;
}

type ForestElement = StageGroupItem | IssueItem | TreeItemView;

export class ForestTreeProvider implements vscode.TreeDataProvider<ForestElement> {
  private _onDidChange = new vscode.EventEmitter<ForestElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private healthCache = new Map<string, { promise: Promise<TreeHealth>; time: number }>();
  private issueCache: { issues: linear.LinearIssue[]; time: number } = { issues: [], time: 0 };
  private readonly HEALTH_TTL = 30_000;
  private readonly ISSUE_TTL = 60_000;

  constructor(private stateManager: StateManager, private config: ForestConfig) {}

  refresh(): void {
    this.healthCache.clear();
    this.issueCache.time = 0;
    this._onDidChange.fire(undefined);
  }

  refreshTrees(): void {
    this.healthCache.clear();
    this._onDidChange.fire(undefined);
  }

  refreshIssues(): void {
    this.issueCache.time = 0;
    this._onDidChange.fire(undefined);
  }

  private getHealth(tree: TreeState): Promise<TreeHealth> {
    const cached = this.healthCache.get(tree.branch);
    if (cached && Date.now() - cached.time < this.HEALTH_TTL) return cached.promise;

    const promise = this.fetchHealth(tree);
    this.healthCache.set(tree.branch, { promise, time: Date.now() });
    return promise;
  }

  private async fetchHealth(tree: TreeState): Promise<TreeHealth> {
    // Shelved trees have no worktree path — can't query git
    if (!tree.path) return { behind: 0, age: null, pr: null };

    const [behind, ahead, pr] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, this.config.baseBranch),
      gh.prStatus(tree.path),
    ]);
    const age = ahead > 0 ? await git.lastCommitAge(tree.path) : null;
    return { behind, age, pr };
  }

  private async getInboxIssues(): Promise<linear.LinearIssue[]> {
    if (!this.config.linear.enabled || !linear.isAvailable()) return [];

    if (Date.now() - this.issueCache.time > this.ISSUE_TTL) {
      this.issueCache.issues = await linear.listMyIssues(this.config.linear.statuses.issueList, this.config.linear.teams);
      this.issueCache.time = Date.now();
    }

    // Filter out issues that already have trees (by ticketId)
    const state = await this.stateManager.load();
    const existingTickets = new Set(
      this.stateManager.getTreesForRepo(state, getRepoPath())
        .filter(t => t.ticketId)
        .map(t => t.ticketId),
    );
    return this.issueCache.issues.filter(i => !existingTickets.has(i.id));
  }

  async getChildren(element?: ForestElement): Promise<ForestElement[]> {
    if (element instanceof TreeItemView || element instanceof IssueItem) return [];
    if (element instanceof StageGroupItem) return element.children as ForestElement[];

    const repoPath = getRepoPath();
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Sort: current window first, then by recency
    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const healthResults = await Promise.all(trees.map(t => this.getHealth(t).catch(() => null)));

    const inProgress: TreeItemView[] = [];
    const inReview: TreeItemView[] = [];
    const done: TreeItemView[] = [];

    trees.forEach((t, i) => {
      const health = healthResults[i] ?? undefined;
      const isCurrent = t.path === curPath;
      const shelved = !t.path;

      let ctx: TreeContext;
      if (shelved) {
        ctx = 'tree-shelved';
      } else if (health?.pr?.state === 'MERGED') {
        ctx = 'tree-done';
      } else if (health?.pr) {
        ctx = 'tree-review';
      } else {
        ctx = 'tree-progress';
      }

      const item = new TreeItemView(t, isCurrent, ctx, health);

      if (ctx === 'tree-done') done.push(item);
      else if (ctx === 'tree-review') inReview.push(item);
      else inProgress.push(item); // includes shelved
    });

    const groups: StageGroupItem[] = [];

    // Inbox (Linear issues without branches)
    if (this.config.linear.enabled) {
      const issues = await this.getInboxIssues();
      if (issues.length) {
        groups.push(new StageGroupItem('Inbox', issues.length, 'inbox', issues.map(i => new IssueItem(i))));
      }
    }

    if (inProgress.length) groups.push(new StageGroupItem('In Progress', inProgress.length, 'code', inProgress));
    if (inReview.length) groups.push(new StageGroupItem('In Review', inReview.length, 'git-pull-request', inReview));
    if (done.length) groups.push(new StageGroupItem('Done', done.length, 'check', done));
    return groups;
  }

  getTreeItem(el: ForestElement): vscode.TreeItem { return el; }
}
