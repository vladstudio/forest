import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ForestConfig } from '../config';
import type { TreeState, StateManager } from '../state';
import type { PortManager } from '../managers/PortManager';
import { slugify } from '../utils/slug';
import { ticketToColor, darken } from '../utils/colors';
import { resolvePortVars } from '../utils/ports';
import * as git from '../cli/git';
import { execShell } from '../utils/exec';
import { getRepoPath } from '../context';

export function copyConfigFiles(config: ForestConfig, repoPath: string, treePath: string): void {
  for (const file of config.copy) {
    const src = path.join(repoPath, file);
    const dst = path.join(treePath, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

export function writeForestEnv(config: ForestConfig, treePath: string, portBase: number): void {
  const envLines: string[] = [];
  for (const [key, val] of Object.entries(config.env)) {
    envLines.push(`${key}=${resolvePortVars(val, config.ports.mapping, portBase)}`);
  }
  fs.writeFileSync(path.join(treePath, '.forest.env'), envLines.join('\n'));
}

export async function runSetupCommands(config: ForestConfig, treePath: string): Promise<void> {
  const cmds = Array.isArray(config.setup) ? config.setup : config.setup ? [config.setup] : [];
  for (const cmd of cmds) {
    try {
      await execShell(cmd, { cwd: treePath, timeout: 120_000 });
    } catch (e: any) {
      vscode.window.showWarningMessage(`Setup command failed: ${e.message}`);
    }
  }
}

/** Shared tree creation logic for seed + plant. */
export async function createTree(opts: {
  ticketId: string;
  title: string;
  config: ForestConfig;
  stateManager: StateManager;
  portManager: PortManager;
}): Promise<TreeState> {
  const { ticketId, title, config, stateManager, portManager } = opts;
  const repoPath = getRepoPath();

  // Check existing
  const state = await stateManager.load();
  if (stateManager.getTree(state, repoPath, ticketId)) {
    throw new Error(`Tree for ${ticketId} already exists`);
  }

  // Check max trees
  const trees = stateManager.getTreesForRepo(state, repoPath);
  if (trees.length >= config.maxTrees) {
    throw new Error(`Max trees (${config.maxTrees}) reached. Fell some trees first.`);
  }

  // Generate branch
  const slug = slugify(title);
  const branch = config.branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slug);

  // Allocate ports
  const portBase = await portManager.allocate(repoPath);

  // Worktree path
  const treePath = path.join(config.treesDir, ticketId);

  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Planting ${ticketId}...`, cancellable: false },
    async (progress) => {
      progress.report({ message: 'Creating worktree...' });
      await git.createWorktree(repoPath, treePath, branch, config.baseBranch);

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, repoPath, treePath);

      progress.report({ message: 'Configuring ports...' });
      writeForestEnv(config, treePath, portBase);

      generateWorkspaceFile(treePath, ticketId, title, config);

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, treePath);

      // Save state
      const tree: TreeState = {
        ticketId, title, branch, path: treePath, repoPath,
        portBase, status: 'dev', createdAt: new Date().toISOString(),
      };
      await stateManager.addTree(repoPath, tree);

      // Open new window
      progress.report({ message: 'Opening window...' });
      const wsFile = path.join(treePath, `${ticketId}.code-workspace`);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });

      return tree;
    },
  );
}

function generateWorkspaceFile(treePath: string, ticketId: string, title: string, config: ForestConfig): void {
  const color = ticketToColor(ticketId);
  const workspace = {
    folders: [{ path: '.' }],
    settings: {
      'window.title': `${ticketId}: ${title} — \${activeEditorShort}`,
      'workbench.colorCustomizations': {
        'titleBar.activeBackground': color,
        'titleBar.activeForeground': '#ffffff',
        'titleBar.inactiveBackground': darken(color, 0.3),
        'titleBar.inactiveForeground': '#cccccc',
        'statusBar.background': color,
        'statusBar.foreground': '#ffffff',
      },
    },
  };
  fs.writeFileSync(path.join(treePath, `${ticketId}.code-workspace`), JSON.stringify(workspace, null, 2));
}
