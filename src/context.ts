import * as vscode from 'vscode';
import type { ForestConfig } from './config';
import type { StateManager, TreeState } from './state';
import type { ShortcutManager } from './managers/ShortcutManager';
import type { StatusBarManager } from './managers/StatusBarManager';
export { resolveMainRepo, getRepoPath } from './utils/repo';

export interface IForestProvider {
  refresh(): void;
  refreshTrees(): void;
  showCreateForm(): void;
  showDeleteForm(branch?: string): Promise<boolean>;
  dispose(): void;
}

export interface ForestContext {
  config: ForestConfig;
  repoPath: string;
  stateManager: StateManager;
  shortcutManager: ShortcutManager;
  statusBarManager: StatusBarManager;
  forestProvider: IForestProvider;
  outputChannel: vscode.OutputChannel;
  currentTree: TreeState | undefined;
}
