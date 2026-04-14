import * as vscode from 'vscode';
import type { ForestConfig, ShortcutConfig } from '../config';
import type { ShortcutManager } from '../managers/ShortcutManager';

type ShortcutState = 'running' | 'stopped' | 'idle';

export class ShortcutItem extends vscode.TreeItem {
  constructor(public readonly shortcut: ShortcutConfig, state: ShortcutState) {
    super(shortcut.name, vscode.TreeItemCollapsibleState.None);

    if (shortcut.type === 'terminal') {
      const running = state === 'running';
      this.contextValue = running ? 'shortcut-terminal-running' : 'shortcut-terminal-stopped';
      this.iconPath = new vscode.ThemeIcon(
        'terminal',
        running ? new vscode.ThemeColor('charts.green') : undefined,
      );
      if (running) this.description = 'running';
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
  private subscription: vscode.Disposable;

  constructor(private config: ForestConfig, private sm: ShortcutManager) {
    this.subscription = sm.onDidChange(() => this._onDidChange.fire(undefined));
  }

  getChildren(): ShortcutItem[] {
    return this.config.shortcuts.map(sc => new ShortcutItem(sc, this.sm.getState(sc)));
  }

  getTreeItem(el: ShortcutItem): vscode.TreeItem { return el; }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChange.dispose();
  }
}
