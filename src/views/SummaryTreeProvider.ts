import * as vscode from 'vscode';

class SummaryItem extends vscode.TreeItem {
  constructor(text: string, fullText?: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.tooltip = fullText ? new vscode.MarkdownString(fullText) : text;
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
    const full = this.lines.join(' ');
    return this.lines.map(line => new SummaryItem(line.trim(), full));
  }

  getTreeItem(el: SummaryItem): vscode.TreeItem { return el; }
}
