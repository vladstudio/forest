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
    this.item.tooltip = `${this.currentTree.ticketId}: ${this.currentTree.title}\nStatus: ${this.currentTree.status}\nClick to survey all trees`;
    this.item.command = 'forest.survey';
    if (this.currentTree.status === 'review') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.show();
  }

  update(tree: TreeState): void {
    this.currentTree = tree;
    this.show();
  }

  dispose(): void { this.item.dispose(); }
}
