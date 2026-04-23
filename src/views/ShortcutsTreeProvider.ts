import * as vscode from 'vscode';
import { type ForestConfig, type ShortcutConfig, allShortcuts } from '../config';

export class ShortcutItem extends vscode.TreeItem {
  constructor(public readonly shortcut: ShortcutConfig) {
    super(shortcut.name, vscode.TreeItemCollapsibleState.None);

    if (shortcut.type === 'terminal') {
      this.contextValue = 'shortcut-terminal';
      this.iconPath = new vscode.ThemeIcon('terminal');
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

export class ShortcutsTreeProvider implements vscode.TreeDataProvider<ShortcutItem>, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<ShortcutItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private config: ForestConfig) {}

  getChildren(): ShortcutItem[] {
    return allShortcuts(this.config.shortcuts).map(sc => new ShortcutItem(sc));
  }

  getTreeItem(el: ShortcutItem): vscode.TreeItem { return el; }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
