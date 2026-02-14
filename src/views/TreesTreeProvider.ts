import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager, TreeState } from '../state';
import { TreeItemView } from './items';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';

export interface TreeHealth {
  behind: number;
  age: string;
  pr: { state: string; reviewDecision: string | null } | null;
}

export class TreesTreeProvider implements vscode.TreeDataProvider<TreeItemView> {
  private _onDidChange = new vscode.EventEmitter<TreeItemView | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private healthCache = new Map<string, { health: TreeHealth; time: number }>();
  private readonly HEALTH_TTL = 30_000;

  constructor(private stateManager: StateManager, private config: ForestConfig) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  private async getHealth(tree: TreeState): Promise<TreeHealth> {
    const cached = this.healthCache.get(tree.ticketId);
    if (cached && Date.now() - cached.time < this.HEALTH_TTL) return cached.health;

    const [behind, age, pr] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.lastCommitAge(tree.path),
      gh.prStatus(tree.path),
    ]);
    const health: TreeHealth = { behind, age, pr };
    this.healthCache.set(tree.ticketId, { health, time: Date.now() });
    return health;
  }

  async getChildren(): Promise<TreeItemView[]> {
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, getRepoPath());
    const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const healthResults = await Promise.all(trees.map(t => this.getHealth(t).catch(() => null)));
    return trees.map((t, i) => new TreeItemView(t, t.path === curPath, healthResults[i] ?? undefined));
  }

  getTreeItem(el: TreeItemView): vscode.TreeItem { return el; }
}
