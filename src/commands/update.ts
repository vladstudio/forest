import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { displayName } from '../state';
import * as git from '../cli/git';
import { copyConfigFiles, runSetupCommands } from './shared';

export async function update(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) {
    vscode.window.showErrorMessage('Update must be run from a tree window.');
    return;
  }
  if (!tree.path) {
    vscode.window.showErrorMessage('Cannot update a shelved tree. Resume it first.');
    return;
  }
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Updating ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: 'Pulling latest...' });
      try {
        await git.pullMerge(tree.path!, config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Merge failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, tree.repoPath, tree.path!);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, tree.path!, ctx.outputChannel);

      vscode.window.showInformationMessage('Tree updated. Dependencies refreshed.');
    },
  );
}

export async function rebase(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) {
    vscode.window.showErrorMessage('Rebase must be run from a tree window.');
    return;
  }
  if (!tree.path) {
    vscode.window.showErrorMessage('Cannot rebase a shelved tree. Resume it first.');
    return;
  }
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Rebasing ${displayName(tree)}...` },
    async (progress) => {
      progress.report({ message: 'Rebasing onto main...' });
      try {
        await git.pullRebase(tree.path!, config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Rebase failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, tree.repoPath, tree.path!);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, tree.path!, ctx.outputChannel);

      vscode.window.showInformationMessage('Tree rebased. Dependencies refreshed.');
    },
  );
}
