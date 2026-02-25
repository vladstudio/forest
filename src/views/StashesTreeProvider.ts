import * as vscode from 'vscode';
import * as git from '../cli/git';
import { StashItem } from './items';

export class StashesTreeProvider implements vscode.TreeDataProvider<StashItem> {
  private _onDidChange = new vscode.EventEmitter<StashItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private repoPath: string) {}

  async getChildren(): Promise<StashItem[]> {
    const entries = await git.stashList(this.repoPath);
    return entries.map(e => new StashItem(e.index, e.message));
  }

  getTreeItem(el: StashItem): vscode.TreeItem { return el; }

  refresh(): void { this._onDidChange.fire(undefined); }
}
