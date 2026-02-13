import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ForestContext } from '../context';
import { exec } from '../utils/exec';

export async function water(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) {
    vscode.window.showErrorMessage('Water must be run from a tree window.');
    return;
  }
  const tree = ctx.currentTree;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Watering ${tree.ticketId}...` },
    async (progress) => {
      // Re-copy files
      progress.report({ message: 'Copying files...' });
      for (const file of ctx.config.copy) {
        const src = path.join(tree.repoPath, file);
        const dst = path.join(tree.path, file);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }

      // Re-write .forest.env
      const ports = ctx.portManager.resolvePorts(tree.portBase);
      const envLines: string[] = [];
      for (const [key, val] of Object.entries(ctx.config.env)) {
        const resolved = val.replace(/\$\{ports\.(\w+)\}/g, (_, n) => String(ports[n] ?? 0));
        envLines.push(`${key}=${resolved}`);
      }
      fs.writeFileSync(path.join(tree.path, '.forest.env'), envLines.join('\n'));

      // Re-run setup
      progress.report({ message: 'Running setup...' });
      const cmds = Array.isArray(ctx.config.setup) ? ctx.config.setup : ctx.config.setup ? [ctx.config.setup] : [];
      for (const cmd of cmds) {
        try {
          await exec(cmd, { cwd: tree.path, timeout: 120_000 });
        } catch (e: any) {
          vscode.window.showWarningMessage(`Setup failed: ${e.message}`);
        }
      }

      vscode.window.showInformationMessage('Tree watered. Dependencies refreshed.');
    },
  );
}
