import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import { copyConfigFiles, requireTree } from './shared';

function showTimedNotification(message: string, ms = 2000): void {
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: message },
    () => new Promise((resolve) => setTimeout(resolve, ms)),
  );
}

async function syncTree(ctx: ForestContext, treeArg: TreeState | undefined, mode: 'merge' | 'rebase'): Promise<void> {
  const label = mode === 'merge' ? 'Update' : 'Rebase';
  const tree = requireTree(ctx, treeArg, label.toLowerCase());
  if (!tree) return;
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${mode === 'merge' ? 'Updating' : 'Rebasing'} ${displayName(tree)}...` },
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

async function gitAction(
  ctx: ForestContext, treeArg: TreeState | undefined,
  opts: { action: string; label: string; gitFn: (tree: TreeState) => Promise<void> },
): Promise<void> {
  const tree = requireTree(ctx, treeArg, opts.action);
  if (!tree) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${opts.label}ing ${displayName(tree)}...` },
    async () => {
      try {
        await opts.gitFn(tree);
      } catch (e: any) {
        vscode.window.showErrorMessage(`${opts.label} failed: ${e.message}`);
        return;
      }
      showTimedNotification(`${opts.label}ed.`);
    },
  );
}

export const pull = (ctx: ForestContext, treeArg?: TreeState) =>
  gitAction(ctx, treeArg, { action: 'pull', label: 'Pull', gitFn: t => git.pull(t.path!) });

export const push = (ctx: ForestContext, treeArg?: TreeState) =>
  gitAction(ctx, treeArg, { action: 'push', label: 'Push', gitFn: t => git.pushBranch(t.path!, t.branch) });
