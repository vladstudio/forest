import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ForestConfig } from './config';
import type { StateManager, TreeState } from './state';
import type { IssuesTreeProvider } from './views/IssuesTreeProvider';
import type { TreesTreeProvider } from './views/TreesTreeProvider';
import type { TerminalManager } from './managers/TerminalManager';
import type { BrowserManager } from './managers/BrowserManager';
import type { PortManager } from './managers/PortManager';
import type { StatusBarManager } from './managers/StatusBarManager';

export interface ForestContext {
  config: ForestConfig;
  stateManager: StateManager;
  portManager: PortManager;
  terminalManager: TerminalManager;
  browserManager: BrowserManager;
  statusBarManager: StatusBarManager;
  issuesProvider: IssuesTreeProvider;
  treesProvider: TreesTreeProvider;
  currentTree: TreeState | undefined;
}

/** Get the main repo path — whether we're in the main repo or a worktree. */
export function getRepoPath(): string {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsPath) return '';
  const gitPath = path.join(wsPath, '.git');
  try {
    if (fs.statSync(gitPath).isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const gitdir = content.replace('gitdir: ', '');
      return path.resolve(gitdir, '..', '..', '..');
    }
  } catch {}
  return wsPath;
}
