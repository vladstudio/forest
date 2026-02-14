import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import { copyConfigFiles, writeForestEnv, runSetupCommands } from './shared';

export async function update(ctx: ForestContext, treeArg?: import('../state').TreeState): Promise<void> {
  const tree = treeArg || ctx.currentTree;
  if (!tree) {
    vscode.window.showErrorMessage('Update must be run from a tree window.');
    return;
  }
  const config = ctx.config;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Updating ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Pulling latest...' });
      try {
        await git.pullMerge(tree.path, config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Merge failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, tree.repoPath, tree.path);

      progress.report({ message: 'Configuring ports...' });
      writeForestEnv(config, tree.path, tree.portBase);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, tree.path, ctx.outputChannel);

      vscode.window.showInformationMessage('Tree updated. Dependencies refreshed.');
    },
  );
}
