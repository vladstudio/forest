import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { StateManager } from '../state';
import { TreeItemView } from './items';
import { getRepoPath } from '../context';

export class TreesTreeProvider implements vscode.TreeDataProvider<TreeItemView> {
  private _onDidChange = new vscode.EventEmitter<TreeItemView | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private config: ForestConfig, private stateManager: StateManager) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  async getChildren(): Promise<TreeItemView[]> {
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, getRepoPath());
    const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return trees.map(t => new TreeItemView(t, t.path === curPath));
  }

  getTreeItem(el: TreeItemView): vscode.TreeItem { return el; }
}
