import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ForestConfig } from '../config';
import type { StateManager, TreeState } from '../state';
import { MainRepoItem, NoTreesItem, StageGroupItem, IssueItem, TreeItemView } from './items';
import type { TreeContext } from './items';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import { filterUnlinkedIssues } from '../commands/shared';

export interface TreeHealth {
  behind: number;
  age: string | null;
  pr: { state: string; reviewDecision: string | null; number?: number; url?: string } | null;
}

type ForestElement = MainRepoItem | NoTreesItem | StageGroupItem | IssueItem | TreeItemView;

export class ForestTreeProvider implements vscode.TreeDataProvider<ForestElement> {
  private _onDidChange = new vscode.EventEmitter<ForestElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private healthCache = new Map<string, { promise: Promise<TreeHealth>; time: number }>();
  private issueCache: { issues: linear.LinearIssue[]; time: number } = { issues: [], time: 0 };
  private readonly CACHE_TTL = 30_000;
  private collapsedGroups: Record<string, boolean>;
  private static readonly COLLAPSED_KEY = 'forest.collapsedGroups';
  private static readonly DEFAULT_COLLAPSED: Record<string, boolean> = { 'Tickets: Todo': true };

  constructor(private stateManager: StateManager, private config: ForestConfig, private globalState: vscode.Memento) {
    this.collapsedGroups = { ...ForestTreeProvider.DEFAULT_COLLAPSED, ...globalState.get<Record<string, boolean>>(ForestTreeProvider.COLLAPSED_KEY, {}) };
  }

  setCollapsed(label: string, collapsed: boolean): void {
    this.collapsedGroups[label] = collapsed;
    this.globalState.update(ForestTreeProvider.COLLAPSED_KEY, this.collapsedGroups);
  }

  refresh(): void {
    this.healthCache.clear();
    this.issueCache.time = 0;
    this._onDidChange.fire(undefined);
  }

  refreshTrees(): void {
    this.healthCache.clear();
    this._onDidChange.fire(undefined);
  }

  private getHealth(tree: TreeState): Promise<TreeHealth> {
    const key = `${tree.repoPath}:${tree.branch}`;
    const cached = this.healthCache.get(key);
    if (cached && Date.now() - cached.time < this.CACHE_TTL) return cached.promise;

    const promise = this.fetchHealth(tree);
    this.healthCache.set(key, { promise, time: Date.now() });
    promise.catch(() => this.healthCache.delete(key));
    return promise;
  }

  private async fetchHealth(tree: TreeState): Promise<TreeHealth> {
    // Path doesn't exist yet (being created in another window)
    if (!tree.path || !fs.existsSync(tree.path)) return { behind: 0, age: null, pr: null };

    const [behind, age, pr] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.lastCommitAge(tree.path),
      // Skip GitHub CLI work entirely when the integration is disabled.
      this.config.github.enabled ? gh.prStatus(tree.path) : Promise.resolve(null),
    ]);
    // Backfill prUrl in state when discovered from GitHub
    if (pr?.url && !tree.prUrl) {
      this.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: pr.url }).catch(() => { });
    }
    return { behind, age, pr };
  }

  private async getTodoIssues(state: Awaited<ReturnType<StateManager['load']>>): Promise<linear.LinearIssue[]> {
    if (!this.config.linear.enabled || !linear.isAvailable()) return [];

    if (Date.now() - this.issueCache.time > this.CACHE_TTL) {
      this.issueCache.issues = await linear.listMyIssues(this.config.linear.statuses.issueList, this.config.linear.teams);
      this.issueCache.time = Date.now();
    }

    return filterUnlinkedIssues(this.issueCache.issues, this.stateManager, state, getRepoPath());
  }

  async getChildren(element?: ForestElement): Promise<ForestElement[]> {
    if (element instanceof MainRepoItem || element instanceof NoTreesItem || element instanceof TreeItemView || element instanceof IssueItem) return [];
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

    const healthResults = await Promise.all(trees.map(t =>
      t.cleaning ? Promise.resolve(null) : this.getHealth(t).catch(() => null),
    ));

    const cleaning: TreeItemView[] = [];
    const inProgress: TreeItemView[] = [];
    const inReview: TreeItemView[] = [];
    const done: TreeItemView[] = [];
    const closed: TreeItemView[] = [];

    trees.forEach((t, i) => {
      const isCurrent = t.path === curPath;

      if (t.cleaning) {
        cleaning.push(new TreeItemView(t, isCurrent, 'tree-cleaning'));
        return;
      }

      const health = healthResults[i] ?? undefined;

      let ctx: TreeContext;
      if (health?.pr?.state === 'MERGED') {
        ctx = 'tree-done';
      } else if (health?.pr?.state === 'CLOSED') {
        ctx = 'tree-closed';
      } else if (health?.pr) {
        ctx = 'tree-review';
      } else {
        ctx = 'tree-progress';
      }

      const item = new TreeItemView(t, isCurrent, ctx, health);

      if (ctx === 'tree-done') done.push(item);
      else if (ctx === 'tree-closed') closed.push(item);
      else if (ctx === 'tree-review') inReview.push(item);
      else inProgress.push(item);
    });

    const groups: StageGroupItem[] = [];
    const isCollapsed = (label: string) => this.collapsedGroups[label] ?? false;

    // Todo (Linear issues without branches)
    if (this.config.linear.enabled) {
      const issues = await this.getTodoIssues(state);
      if (issues.length) {
        groups.push(new StageGroupItem('Tickets: Todo', issues.length, 'inbox', issues.map(i => new IssueItem(i)), isCollapsed('Tickets: Todo')));
      }
    }

    if (cleaning.length) groups.push(new StageGroupItem('Trees: Cleaning up', cleaning.length, 'loading~spin', cleaning, false));
    if (inProgress.length) groups.push(new StageGroupItem('Trees: In progress', inProgress.length, 'target', inProgress, isCollapsed('Trees: In progress')));
    if (inReview.length) groups.push(new StageGroupItem('Trees: In review', inReview.length, 'git-pull-request', inReview, isCollapsed('Trees: In review')));
    if (done.length) groups.push(new StageGroupItem('Trees: Done', done.length, 'check', done, isCollapsed('Trees: Done')));
    if (closed.length) groups.push(new StageGroupItem('Trees: Closed', closed.length, 'git-pull-request-closed', closed, isCollapsed('Trees: Closed')));
    if (!trees.length) groups.push(new StageGroupItem('Trees', 0, 'folder', [new NoTreesItem()], false));
    const mainIsCurrent = curPath === repoPath;
    return [new MainRepoItem(repoPath, this.config.baseBranch, mainIsCurrent), ...groups];
  }

  getTreeItem(el: ForestElement): vscode.TreeItem { return el; }
  dispose(): void { this._onDidChange.dispose(); }
}
