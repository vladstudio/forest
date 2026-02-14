import * as vscode from 'vscode';
import type { TreeState } from '../state';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  constructor(private currentTree: TreeState | undefined) {
    this.item = vscode.window.createStatusBarItem('forest.tree', vscode.StatusBarAlignment.Left, 100);
  }

  show(): void {
    if (!this.currentTree) return;
    this.item.text = `$(git-branch) ${this.currentTree.ticketId}`;
    this.item.tooltip = `${this.currentTree.ticketId}: ${this.currentTree.title}\nClick to list all trees`;
    this.item.command = 'forest.list';
    this.item.show();
  }

  update(tree: TreeState): void {
    this.currentTree = tree;
    this.show();
  }

  dispose(): void { this.item.dispose(); }
}
