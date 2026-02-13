import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { copyConfigFiles, writeForestEnv, runSetupCommands } from './shared';

export async function water(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) {
    vscode.window.showErrorMessage('Water must be run from a tree window.');
    return;
  }
  const tree = ctx.currentTree;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Watering ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Copying files...' });
      copyConfigFiles(ctx.config, tree.repoPath, tree.path);

      progress.report({ message: 'Configuring ports...' });
      writeForestEnv(ctx.config, tree.path, tree.portBase);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(ctx.config, tree.path);

      vscode.window.showInformationMessage('Tree watered. Dependencies refreshed.');
    },
  );
}
