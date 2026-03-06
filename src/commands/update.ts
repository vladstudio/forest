import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import { copyConfigFiles, runSetupCommands } from './shared';

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

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, tree.path!, ctx.outputChannel);

      showTimedNotification(`Tree ${mode === 'merge' ? 'updated' : 'rebased'}. Dependencies refreshed.`);
    },
  );
}

export const update = (ctx: ForestContext, treeArg?: TreeState) => syncTree(ctx, treeArg, 'merge');
export const rebase = (ctx: ForestContext, treeArg?: TreeState) => syncTree(ctx, treeArg, 'rebase');
