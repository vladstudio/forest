import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { ForestConfig } from './config';
import type { StateManager, TreeState } from './state';
import type { ShortcutManager } from './managers/ShortcutManager';
import type { StatusBarManager } from './managers/StatusBarManager';

export interface IForestProvider {
  refresh(): void;
  refreshTrees(): void;
  showCreateForm(): Promise<boolean>;
  showCreateFormWithIssue(issue: { id: string; title: string }): Promise<boolean>;
  showDeleteForm(branch?: string): Promise<boolean>;
  dispose(): void;
}

export interface ITodosProvider {
  refresh(): void;
  dispose(): void;
}

export interface ForestContext {
  config: ForestConfig;
  repoPath: string;
  stateManager: StateManager;
  shortcutManager: ShortcutManager;
  statusBarManager: StatusBarManager;
  forestProvider: IForestProvider;
  todosProvider?: ITodosProvider;
  outputChannel: vscode.OutputChannel;
  currentTree: TreeState | undefined;
}

/** Resolve main repo root from any path (worktree or main). */
export function resolveMainRepo(wsPath: string): string {
  const gitPath = path.join(wsPath, '.git');
  try {
    if (fs.statSync(gitPath).isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const gitdir = path.resolve(wsPath, content.replace('gitdir: ', ''));
      // Use commondir (written by git for worktrees) for robust resolution
      try {
        const commondir = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
        return path.dirname(path.resolve(gitdir, commondir));
      } catch {
        const common = execFileSync('git', ['-C', wsPath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
        return path.dirname(path.resolve(wsPath, common));
      }
    }
  } catch { /* not a worktree — wsPath is the main repo */ }
  return wsPath;
}

/** Resolve the host filesystem path for the current workspace folder.
 *  In a dev container, the workspace URI is remote (`/workspaces/<basename>`);
 *  Forest is host-side, so we look up the matching tree by basename in state.json. */
export function getHostWorkspacePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  if (folder.uri.scheme === 'file') return folder.uri.fsPath;
  const basename = path.basename(folder.uri.path);
  try {
    const statePath = path.join(os.homedir(), '.forest', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { trees?: Record<string, TreeState> };
    const matches = Object.values(state.trees ?? {}).filter(tree => tree.path && path.basename(tree.path) === basename);
    return matches.length === 1 ? matches[0].path : undefined;
  } catch { /* state unreadable — bail */ }
  return undefined;
}

/** Get the main repo path for the current workspace. */
export function getRepoPath(): string {
  const wsPath = getHostWorkspacePath();
  if (!wsPath) throw new Error('Forest: no workspace folder open');
  return resolveMainRepo(wsPath);
}
