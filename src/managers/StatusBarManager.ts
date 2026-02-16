import * as vscode from 'vscode';
import type { TreeState } from '../state';
import { displayName } from '../state';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  constructor(private currentTree: TreeState | undefined) {
    this.item = vscode.window.createStatusBarItem('forest.tree', vscode.StatusBarAlignment.Left, 100);
  }

  show(): void {
    if (!this.currentTree) return;
    const name = displayName(this.currentTree);
    this.item.text = `$(git-branch) ${this.currentTree.ticketId ?? this.currentTree.branch}`;
    this.item.tooltip = `${name}\nClick to list all trees`;
    this.item.command = 'forest.list';
    this.item.show();
  }

  update(tree: TreeState): void {
    this.currentTree = tree;
    this.show();
  }

  dispose(): void { this.item.dispose(); }
}
