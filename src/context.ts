import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ForestConfig } from './config';
import type { StateManager, TreeState } from './state';
import type { ForestTreeProvider } from './views/ForestTreeProvider';
import type { ShortcutManager } from './managers/ShortcutManager';
import type { StatusBarManager } from './managers/StatusBarManager';

export interface ForestContext {
  config: ForestConfig;
  stateManager: StateManager;
  shortcutManager: ShortcutManager;
  statusBarManager: StatusBarManager;
  forestProvider: ForestTreeProvider;
  outputChannel: vscode.OutputChannel;
  currentTree: TreeState | undefined;
}

/** Resolve main repo root from any path (worktree or main). */
export function resolveMainRepo(wsPath: string): string {
  const gitPath = path.join(wsPath, '.git');
  try {
    if (fs.statSync(gitPath).isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const gitdir = content.replace('gitdir: ', '');
      return path.resolve(gitdir, '..', '..', '..');
    }
  } catch {}
  return wsPath;
}

/** Get the main repo path for the current workspace. */
export function getRepoPath(): string {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsPath) throw new Error('Forest: no workspace folder open');
  return resolveMainRepo(wsPath);
}
