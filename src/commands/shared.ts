import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { type ForestConfig, getTreesDir } from '../config';
import type { ForestContext } from '../context';
import type { TreeState, StateManager } from '../state';
import { displayName } from '../state';
import { slugify } from '../utils/slug';
import * as git from '../cli/git';
import * as linear from '../cli/linear';
import { exec as execUtil, execShell, execStream } from '../utils/exec';
import { getRepoPath } from '../context';
import { log } from '../logger';

/** Run an async step, log to output channel, show error notification on failure. */
export async function runStep(ctx: ForestContext, label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    log.info(`Step "${label}": done`);
    ctx.outputChannel.appendLine(`[Forest] ${label}: done`);
    return true;
  } catch (e: any) {
    log.error(`Step "${label}": FAILED — ${e.stack ?? e.message}`);
    ctx.outputChannel.appendLine(`[Forest] ${label}: FAILED — ${e.message}`);
    ctx.outputChannel.show(true);
    vscode.window.showErrorMessage(`${label}: ${e.message}`);
    return false;
  }
}

/** Pick a team key for issue creation. Returns undefined if cancelled. */
export async function pickTeam(teams?: string[]): Promise<string | undefined> {
  if (!teams?.length) {
    vscode.window.showErrorMessage('Forest: No Linear teams configured. Set "teams" in .forest/config.json.');
    return undefined;
  }
  if (teams.length === 1) return teams[0];
  const pick = await vscode.window.showQuickPick(
    teams.map(t => ({ label: t })),
    { placeHolder: 'Which team?' },
  );
  return pick?.label;
}

export async function updateLinear(ctx: ForestContext, ticketId: string, status: string | undefined): Promise<void> {
  if (!status) { log.info(`updateLinear skipped: no status configured (${ticketId})`); return; }
  if (!ctx.config.linear.enabled) { log.info(`updateLinear skipped: linear not enabled (${ticketId} → ${status})`); return; }
  if (!linear.isAvailable()) { log.warn(`updateLinear skipped: linear not available/no API key (${ticketId} → ${status})`); return; }
  await runStep(ctx, `Linear ${ticketId} → ${status}`, () => linear.updateIssueState(ticketId, status));
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

/** Sanitize branch name for use as filename. */
function sanitizeBranch(branch: string): string {
  return branch
    .replace(/\.\./g, '')
    .replace(/\//g, '--')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-');
}

/** If there are uncommitted changes, ask what to do. Returns true if stashed, false if clean/discarded, undefined if cancelled. */
export async function promptUncommittedChanges(repoPath: string): Promise<boolean | undefined> {
  if (!await git.hasUncommittedChanges(repoPath)) return false;
  const pick = await vscode.window.showQuickPick([
    { label: '$(arrow-right) Carry to new tree', id: 'carry' },
    { label: '$(trash) Discard changes', id: 'discard' },
  ], { placeHolder: 'You have uncommitted changes' });
  if (!pick) return undefined;
  if (pick.id === 'carry') { await git.stash(repoPath); return true; }
  await git.discardChanges(repoPath);
  return false;
}

/** Shared tree creation logic. */
export async function createTree(opts: {
  branch: string;
  config: ForestConfig;
  stateManager: StateManager;
  ticketId?: string;
  title?: string;
  existingBranch?: boolean;
  carryChanges?: boolean;
}): Promise<TreeState> {
  const { branch, config, stateManager, ticketId, title, existingBranch, carryChanges } = opts;
  const repoPath = getRepoPath();

  // Check existing
  const state = await stateManager.load();
  if (stateManager.getTree(state, repoPath, branch)) {
    throw new Error(`Tree for branch "${branch}" already exists`);
  }

  // Check max trees
  const trees = stateManager.getTreesForRepo(state, repoPath);
  const activeTrees = trees.filter(t => t.path);
  if (activeTrees.length >= config.maxTrees) {
    throw new Error(`Max trees (${config.maxTrees}) reached. Clean up some trees first.`);
  }

  // Worktree path — use ticketId if available (shorter, cleaner), else sanitized branch
  const treesDir = getTreesDir(repoPath);
  fs.mkdirSync(treesDir, { recursive: true });
  const dirName = ticketId ?? sanitizeBranch(branch);
  const treePath = path.join(treesDir, dirName);

  const tree: TreeState = {
    branch, repoPath, path: treePath,
    createdAt: new Date().toISOString(),
    ...(ticketId ? { ticketId } : {}),
    ...(title ? { title } : {}),
  };

  log.info(`createTree: ${branch} ticket=${ticketId ?? '(none)'} existing=${!!existingBranch} carry=${!!carryChanges}`);
  // Save state early to prevent duplicates across windows.
  await stateManager.addTree(repoPath, tree);

  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating tree for ${displayName(tree)}...`, cancellable: false },
      async (progress) => {
        progress.report({ message: 'Creating worktree...' });
        if (existingBranch) {
          await git.checkoutWorktree(repoPath, treePath, branch);
        } else {
          await git.createWorktree(repoPath, treePath, branch, config.baseBranch);
        }
        if (carryChanges) {
          try { await git.stashPop(treePath); } catch {
            // Conflict — unstash back to main repo so changes aren't lost
            await git.stashPop(repoPath).catch(() => {});
            throw new Error('Could not apply uncommitted changes to new tree (conflict). Changes restored to main repo.');
          }
        }

        progress.report({ message: 'Copying files...' });
        copyConfigFiles(config, repoPath, treePath);

        generateWorkspaceFile(repoPath, treePath, tree);

        const hadTemplate = await copyModulesFromTemplate(repoPath, treePath);

        if (fs.existsSync(path.join(treePath, '.envrc'))) {
          try { await execShell('direnv allow', { cwd: treePath, timeout: 10_000 }); } catch {}
        }

        progress.report({ message: 'Running setup...' });
        await runSetupCommands(config, treePath);

        if (!hadTemplate) await saveTemplate(repoPath, treePath);

        progress.report({ message: 'Publishing branch...' });
        await git.pushBranch(treePath, branch).catch(() => {});

        progress.report({ message: 'Opening window...' });
        const wsFile = workspaceFilePath(repoPath, branch);
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });

        return tree;
      },
    );
  } catch (e: any) {
    log.error(`createTree failed: ${branch} — ${e.message}`);
    await stateManager.removeTree(repoPath, branch);
    await git.removeWorktree(repoPath, treePath).catch(() => {});
    if (!existingBranch) await git.deleteBranch(repoPath, branch).catch(() => {});
    throw e;
  }
}

/** Recreate a worktree for a shelved tree. */
export async function resumeTree(opts: {
  tree: TreeState;
  config: ForestConfig;
  stateManager: StateManager;
}): Promise<TreeState> {
  const { tree, config, stateManager } = opts;
  const repoPath = tree.repoPath;

  // Check max trees
  const state = await stateManager.load();
  const trees = stateManager.getTreesForRepo(state, repoPath);
  const activeTrees = trees.filter(t => t.path);
  if (activeTrees.length >= config.maxTrees) {
    throw new Error(`Max trees (${config.maxTrees}) reached. Clean up some trees first.`);
  }

  const treesDir = getTreesDir(repoPath);
  fs.mkdirSync(treesDir, { recursive: true });
  const dirName = tree.ticketId ?? sanitizeBranch(tree.branch);
  const treePath = path.join(treesDir, dirName);

  log.info(`resumeTree: ${tree.branch}`);
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Resuming ${displayName(tree)}...`, cancellable: false },
    async (progress) => {
      progress.report({ message: 'Creating worktree...' });
      await git.checkoutWorktree(repoPath, treePath, tree.branch);

      progress.report({ message: 'Copying files...' });
      copyConfigFiles(config, repoPath, treePath);

      generateWorkspaceFile(repoPath, treePath, tree);

      await copyModulesFromTemplate(repoPath, treePath);

      if (fs.existsSync(path.join(treePath, '.envrc'))) {
        try { await execShell('direnv allow', { cwd: treePath, timeout: 10_000 }); } catch {}
      }

      progress.report({ message: 'Running setup...' });
      await runSetupCommands(config, treePath);

      // Update state with new path
      await stateManager.updateTree(repoPath, tree.branch, { path: treePath });

      progress.report({ message: 'Opening window...' });
      const wsFile = workspaceFilePath(repoPath, tree.branch);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceNewWindow: true });

      return { ...tree, path: treePath };
    },
  );
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

export function workspaceFilePath(repoPath: string, branch: string): string {
  return path.join(os.homedir(), '.forest', 'workspaces', `${sanitizeBranch(branch)}.code-workspace`);
}

function generateWorkspaceFile(repoPath: string, treePath: string, tree: TreeState): void {
  const wsPath = workspaceFilePath(repoPath, tree.branch);
  fs.mkdirSync(path.dirname(wsPath), { recursive: true });
  const name = displayName(tree);
  const workspace = {
    folders: [{ path: treePath }],
    settings: {
      'window.title': `${name}\${separator}\${activeEditorShort}`,
      'terminal.integrated.enablePersistentSessions': false,
    },
  };
  fs.writeFileSync(wsPath, JSON.stringify(workspace, null, 2));
}
