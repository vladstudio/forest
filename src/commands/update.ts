import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import { copyConfigFiles, writeForestEnv, runSetupCommands } from './shared';

export async function update(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) {
    vscode.window.showErrorMessage('Update must be run from a tree window.');
    return;
  }
  const tree = ctx.currentTree;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Updating ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Rebasing on latest...' });
      try {
        await git.rebase(tree.path, ctx.config.baseBranch);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Rebase failed: ${e.message}. Resolve conflicts manually.`);
        return;
      }

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(ctx.config, tree.repoPath, tree.path);

      progress.report({ message: 'Configuring ports...' });
      writeForestEnv(ctx.config, tree.path, tree.portBase);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(ctx.config, tree.path, ctx.outputChannel);

      vscode.window.showInformationMessage('Tree updated. Dependencies refreshed.');
    },
  );
}
