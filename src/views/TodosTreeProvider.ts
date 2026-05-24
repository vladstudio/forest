import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import * as linear from '../cli/linear';

export class TodoItem extends vscode.TreeItem {
	constructor(public readonly issue: linear.LinearIssue) {
		super(issue.title, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'todo';
		this.iconPath = new vscode.ThemeIcon('circle-outline');
		this.description = issue.id;
		this.command = {
			command: 'forest.todoCreateTree',
			title: 'Create Tree',
			arguments: [this],
		};
		this.tooltip = `${issue.id}: ${issue.title}`;
	}
}

export class TodosTreeProvider implements vscode.TreeDataProvider<TodoItem | vscode.TreeItem>, vscode.Disposable {
	private _onDidChange = new vscode.EventEmitter<TodoItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;
	private issues: linear.LinearIssue[] = [];
	private loading = false;
	private error = false;
	private request = 0;

	constructor(
		private config: ForestConfig,
		private outputChannel?: vscode.OutputChannel,
	) {}

	refresh(): void {
		this.loadIssues();
	}

	getChildren(): (TodoItem | vscode.TreeItem)[] {
		if (this.loading) {
			return [new vscode.TreeItem('Loading…', vscode.TreeItemCollapsibleState.None)];
		}
		if (this.error) {
			const item = new vscode.TreeItem('Failed to load issues', vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('error');
			item.description = 'Click refresh to retry';
			return [item];
		}
		if (!this.issues.length) {
			return [new vscode.TreeItem('No issues in todo status', vscode.TreeItemCollapsibleState.None)];
		}
		return this.issues.map(issue => new TodoItem(issue));
	}

	getTreeItem(el: TodoItem | vscode.TreeItem): vscode.TreeItem {
		return el;
	}

	private async loadIssues(): Promise<void> {
		const request = ++this.request;
		if (!this.config.linear.enabled || !linear.isAvailable()) return;
		this.loading = true;
		this.error = false;
		this._onDidChange.fire(undefined);
		try {
			const issues = await linear.listMyIssues(
				this.config.linear.statuses.issueList,
				this.config.linear.teams,
			);
			if (request !== this.request) return;
			this.issues = issues;
		} catch (e: any) {
			if (request !== this.request) return;
			this.issues = [];
			this.error = true;
			this.outputChannel?.appendLine(`[Forest] Failed to load todos: ${e.message}`);
		} finally {
			if (request !== this.request) return;
			this.loading = false;
			this._onDidChange.fire(undefined);
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
