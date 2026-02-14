import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { type ForestConfig, getTreesDir } from '../config';
import type { ForestContext } from '../context';
import type { TreeState, StateManager } from '../state';
import type { PortManager } from '../managers/PortManager';
import { slugify } from '../utils/slug';
import { resolvePortVars } from '../utils/ports';
import * as git from '../cli/git';
import * as linear from '../cli/linear';
import { exec as execUtil, execShell, execStream } from '../utils/exec';
import { getRepoPath } from '../context';

/** Run an async step, log to output channel, show error notification on failure. */
export async function runStep(ctx: ForestContext, label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    ctx.outputChannel.appendLine(`[Forest] ${label}: done`);
    return true;
  } catch (e: any) {
    ctx.outputChannel.appendLine(`[Forest] ${label}: FAILED — ${e.message}`);
    ctx.outputChannel.show(true);
    vscode.window.showErrorMessage(`${label}: ${e.message}`);
    return false;
  }
}

export async function updateLinear(ctx: ForestContext, ticketId: string, status: string): Promise<void> {
  if (ctx.config.linear.enabled && await linear.isAvailable()) {
    await runStep(ctx, `Linear ${ticketId} → ${status}`, () => linear.updateIssueState(ticketId, status));
  }
}

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

export async function runSetupCommands(config: ForestConfig, treePath: string, channel?: vscode.OutputChannel): Promise<void> {
  const cmds = Array.isArray(config.setup) ? config.setup : config.setup ? [config.setup] : [];
  for (const cmd of cmds) {
    try {
      if (channel) {
        channel.appendLine(`$ ${cmd}`);
        channel.show(true);
        await execStream(cmd, {
          cwd: treePath,
          timeout: 120_000,
          onData: (chunk) => channel.append(chunk),
        });
        channel.appendLine('');
      } else {
        await execShell(cmd, { cwd: treePath, timeout: 120_000 });
      }
    } catch (e: any) {
      vscode.window.showWarningMessage(`Setup command failed: ${e.message}`);
    }
  }
}

/** Shared tree creation logic for newIssueTree + newTree. */
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
    throw new Error(`Max trees (${config.maxTrees}) reached. Clean up some trees first.`);
  }

  // Generate branch
  const slug = slugify(title);
  const branch = config.branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slug);

  // Allocate ports
  const portBase = await portManager.allocate(repoPath);

  // Worktree path
  const treesDir = getTreesDir(repoPath);
  fs.mkdirSync(treesDir, { recursive: true });
  const treePath = path.join(treesDir, ticketId);

  const tree: TreeState = {
    ticketId, title, branch, path: treePath, repoPath,
    portBase, createdAt: new Date().toISOString(),
  };

  // Save state early to reserve port and prevent duplicates across windows.
  // The state watcher cleanup handles removal if any step below fails.
  await stateManager.addTree(repoPath, tree);

  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating tree for ${ticketId}...`, cancellable: false },
      async (progress) => {
        progress.report({ message: 'Creating worktree...' });
        await git.createWorktree(repoPath, treePath, branch, config.baseBranch);

        progress.report({ message: 'Copying files...' });
        copyConfigFiles(config, repoPath, treePath);

        progress.report({ message: 'Configuring ports...' });
        writeForestEnv(config, treePath, portBase);

        generateWorkspaceFile(repoPath, treePath, ticketId, title);
        writeGitExclude(treePath);

        const hadTemplate = await copyModulesFromTemplate(repoPath, treePath);

        if (fs.existsSync(path.join(treePath, '.envrc'))) {
          try { await execShell('direnv allow', { cwd: treePath, timeout: 10_000 }); } catch {}
        }

        progress.report({ message: 'Running setup...' });
        await runSetupCommands(config, treePath);

        if (!hadTemplate) await saveTemplate(repoPath, treePath);

        progress.report({ message: 'Opening window...' });
        const wsFile = workspaceFilePath(repoPath, ticketId);
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });

        return tree;
      },
    );
  } catch (e) {
    await stateManager.removeTree(repoPath, ticketId);
    await git.removeWorktree(repoPath, treePath).catch(() => {});
    await git.deleteBranch(repoPath, branch).catch(() => {});
    throw e;
  }
}

function templateDir(repoPath: string): string {
  return path.join(getTreesDir(repoPath), '.template');
}

export async function copyModulesFromTemplate(repoPath: string, treePath: string): Promise<boolean> {
  const src = path.join(templateDir(repoPath), 'node_modules');
  const dst = path.join(treePath, 'node_modules');
  if (!fs.existsSync(src)) return false;
  try {
    const flag = os.platform() === 'darwin' ? '-Rc' : '-al';
    await execUtil('cp', [flag, src, dst]);
    return true;
  } catch { return false; }
}

export async function saveTemplate(repoPath: string, treePath: string): Promise<void> {
  const src = path.join(treePath, 'node_modules');
  if (!fs.existsSync(src)) return;
  const tplDir = templateDir(repoPath);
  fs.mkdirSync(tplDir, { recursive: true });
  const dst = path.join(tplDir, 'node_modules');
  try {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true });
    const flag = os.platform() === 'darwin' ? '-Rc' : '-al';
    await execUtil('cp', [flag, src, dst]);
  } catch {}
}

export async function warmTemplate(): Promise<void> {
  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!curPath) return;
  await saveTemplate(getRepoPath(), curPath);
  vscode.window.showInformationMessage('Forest: Template warmed from current tree.');
}

export function workspaceFilePath(repoPath: string, ticketId: string): string {
  const dir = path.join(os.homedir(), '.forest', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${ticketId}.code-workspace`);
}

function writeGitExclude(treePath: string): void {
  const excludePath = path.join(treePath, '.git', 'info', 'exclude');
  const marker = '# Forest-generated';
  const entries = `\n${marker}\n.forest.env\n`;
  try {
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (!existing.includes(marker)) {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.appendFileSync(excludePath, entries);
    }
  } catch {}
}

function generateWorkspaceFile(repoPath: string, treePath: string, ticketId: string, title: string): void {
  const workspace = {
    folders: [{ path: treePath }],
    settings: {
      'window.title': `${ticketId}: ${title}\${separator}\${activeEditorShort}`,
      'terminal.integrated.enablePersistentSessions': false,
    },
  };
  fs.writeFileSync(workspaceFilePath(repoPath, ticketId), JSON.stringify(workspace, null, 2));
}
