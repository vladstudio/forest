import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import { copyConfigFiles } from './shared';

function showTimedNotification(message: string, ms = 2000): void {
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: message },
    () => new Promise((resolve) => setTimeout(resolve, ms)),
  );
}

async function syncTree(ctx: ForestContext, treeArg: TreeState | undefined, mode: 'merge' | 'rebase'): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  const label = mode === 'merge' ? 'Update' : 'Rebase';
  if (!tree) { vscode.window.showErrorMessage(`${label} must be run from a tree window.`); return; }
  if (!tree.path) { vscode.window.showErrorMessage(`Cannot ${mode}: tree has no worktree path.`); return; }
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${label === 'Update' ? 'Updating' : 'Rebasing'} ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: mode === 'merge' ? 'Pulling latest...' : 'Rebasing onto main...' });
      try {
        await (mode === 'merge' ? git.pullMerge : git.pullRebase)(tree.path!, config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`${label} failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, tree.repoPath, tree.path!);

      showTimedNotification(`Tree ${mode === 'merge' ? 'updated' : 'rebased'}.`);
    },
  );
}

export const update = (ctx: ForestContext, treeArg?: TreeState) => syncTree(ctx, treeArg, 'merge');
export const rebase = (ctx: ForestContext, treeArg?: TreeState) => syncTree(ctx, treeArg, 'rebase');

export async function pull(ctx: ForestContext, treeArg?: TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) { vscode.window.showErrorMessage('Pull must be run from a tree window.'); return; }
  if (!tree.path) { vscode.window.showErrorMessage('Cannot pull: tree has no worktree path.'); return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pulling ${displayName(tree)}...` },
    async () => {
      try {
        await git.pull(tree.path!);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
        return;
      }
      showTimedNotification('Pulled.');
    },
  );
}

export async function push(ctx: ForestContext, treeArg?: TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) { vscode.window.showErrorMessage('Push must be run from a tree window.'); return; }
  if (!tree.path) { vscode.window.showErrorMessage('Cannot push: tree has no worktree path.'); return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pushing ${displayName(tree)}...` },
    async () => {
      try {
        await git.pushBranch(tree.path!, tree.branch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Push failed: ${e.message}`);
        return;
      }
      showTimedNotification('Pushed.');
    },
  );
}
