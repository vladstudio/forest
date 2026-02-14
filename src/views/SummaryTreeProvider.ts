import * as vscode from 'vscode';

class SummaryItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.tooltip = text;
  }
}

export class SummaryTreeProvider implements vscode.TreeDataProvider<SummaryItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private lines: string[] = [];

  setSummary(text: string): void {
    this.lines = text ? text.split(/(?<=\.)\s+/) : [];
    this._onDidChange.fire();
  }

  getChildren(): SummaryItem[] {
    return this.lines.map(line => new SummaryItem(line.trim()));
  }

  getTreeItem(el: SummaryItem): vscode.TreeItem { return el; }
}
