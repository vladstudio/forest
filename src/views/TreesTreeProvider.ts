import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager, TreeState } from '../state';
import { TreeItemView, TreeGroupItem } from './items';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';

export interface TreeHealth {
  behind: number;
  age: string | null;
  pr: { state: string; reviewDecision: string | null } | null;
}

type TreeElement = TreeGroupItem | TreeItemView;

export class TreesTreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private _onDidChange = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private healthCache = new Map<string, { health: TreeHealth; time: number }>();
  private readonly HEALTH_TTL = 30_000;

  constructor(private stateManager: StateManager, private config: ForestConfig) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  private async getHealth(tree: TreeState): Promise<TreeHealth> {
    const cached = this.healthCache.get(tree.ticketId);
    if (cached && Date.now() - cached.time < this.HEALTH_TTL) return cached.health;

    const [behind, ahead, pr] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, this.config.baseBranch),
      gh.prStatus(tree.path),
    ]);
    const age = ahead > 0 ? await git.lastCommitAge(tree.path) : null;
    const health: TreeHealth = { behind, age, pr };
    this.healthCache.set(tree.ticketId, { health, time: Date.now() });
    return health;
  }

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element instanceof TreeItemView) return [];
    if (element instanceof TreeGroupItem) return element.trees;

    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, getRepoPath());
    const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
      const item = new TreeItemView(t, t.path === curPath, health);
      if (!health?.pr) inProgress.push(item);
      else if (health.pr.state === 'MERGED') done.push(item);
      else inReview.push(item);
    });

    const groups: TreeGroupItem[] = [];
    if (inProgress.length) groups.push(new TreeGroupItem('In Progress', inProgress, 'code'));
    if (inReview.length) groups.push(new TreeGroupItem('In Review', inReview, 'git-pull-request'));
    if (done.length) groups.push(new TreeGroupItem('Done', done, 'check'));
    return groups;
  }

  getTreeItem(el: TreeElement): vscode.TreeItem { return el; }
}
