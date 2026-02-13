import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { ShortcutManager } from '../managers/ShortcutManager';
import { ShortcutItem } from './items';

export class ShortcutsTreeProvider implements vscode.TreeDataProvider<ShortcutItem> {
  private _onDidChange = new vscode.EventEmitter<ShortcutItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private config: ForestConfig, private sm: ShortcutManager) {
    sm.onDidChange(() => this._onDidChange.fire(undefined));
  }

  getChildren(): ShortcutItem[] {
    return this.config.shortcuts.map(sc => new ShortcutItem(sc, this.sm.getState(sc)));
  }

  getTreeItem(el: ShortcutItem): vscode.TreeItem { return el; }
}
