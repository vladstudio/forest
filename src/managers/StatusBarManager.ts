import * as vscode from 'vscode';
import type { TreeState } from '../state';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private summaryItem: vscode.StatusBarItem;

  constructor(private currentTree: TreeState | undefined) {
    this.item = vscode.window.createStatusBarItem('forest.tree', vscode.StatusBarAlignment.Left, 100);
    this.summaryItem = vscode.window.createStatusBarItem('forest.summary', vscode.StatusBarAlignment.Left, 99);
  }

  show(): void {
    if (!this.currentTree) return;
    this.item.text = `$(git-branch) ${this.currentTree.ticketId}`;
    this.item.tooltip = `${this.currentTree.ticketId}: ${this.currentTree.title}\nClick to list all trees`;
    this.item.command = 'forest.list';
    this.item.show();
  }

  setSummary(text: string): void {
    if (!text) {
      this.summaryItem.hide();
      return;
    }
    const maxLen = 80;
    const display = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
    this.summaryItem.text = `$(info) ${display}`;
    this.summaryItem.tooltip = text;
    this.summaryItem.command = 'forest.treeSummary';
    this.summaryItem.show();
  }

  update(tree: TreeState): void {
    this.currentTree = tree;
    this.show();
  }

  dispose(): void { this.item.dispose(); this.summaryItem.dispose(); }
}
