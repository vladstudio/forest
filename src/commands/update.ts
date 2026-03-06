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

async function pullAndRefresh(
  ctx: ForestContext, treeArg: TreeState | undefined, verb: string, gerund: string,
  pullFn: (path: string, base: string) => Promise<void>, message: string,
): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) { vscode.window.showErrorMessage(`${verb} must be run from a tree window.`); return; }
  if (!tree.path) { vscode.window.showErrorMessage(`Cannot ${verb.toLowerCase()} a shelved tree. Resume it first.`); return; }
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${gerund} ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: 'Pulling latest...' });
      try {
        await pullFn(tree.path!, config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`${verb} failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, tree.repoPath, tree.path!);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, tree.path!, ctx.outputChannel);

      showTimedNotification(message);
    },
  );
}

export async function update(ctx: ForestContext, treeArg?: TreeState): Promise<void> {
  return pullAndRefresh(ctx, treeArg, 'Update', 'Updating', git.pullMerge, 'Tree updated. Dependencies refreshed.');
}

export async function rebase(ctx: ForestContext, treeArg?: TreeState): Promise<void> {
  return pullAndRefresh(ctx, treeArg, 'Rebase', 'Rebasing', git.pullRebase, 'Tree rebased. Dependencies refreshed.');
}
