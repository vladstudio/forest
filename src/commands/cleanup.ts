import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { getRepoPath } from '../context';
import { runStep, updateLinear, workspaceFilePath } from './shared';

const preservedBranchesPath = path.join(os.homedir(), '.forest', 'preserved-branches.json');

function readPreservedBranches(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(preservedBranchesPath, 'utf8'))); } catch { return new Set(); }
}

function writePreservedBranches(set: Set<string>): void {
  fs.writeFileSync(preservedBranchesPath, JSON.stringify([...set]), 'utf8');
}

export function consumePreservedBranch(branch: string): boolean {
  const set = readPreservedBranches();
  if (!set.has(branch)) return false;
  set.delete(branch);
  writePreservedBranches(set);
  return true;
}

function resolveTree(ctx: ForestContext, ticketIdArg?: string): TreeState | undefined {
  return ticketIdArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), ticketIdArg)
    : ctx.currentTree;
}

const teardownInProgress = new Set<string>();

async function teardownTree(ctx: ForestContext, tree: TreeState, keepBranch = false): Promise<void> {
  const key = `${tree.repoPath}:${tree.ticketId}`;
  if (teardownInProgress.has(key)) return;
  teardownInProgress.add(key);
  try {
    const shouldClose = ctx.currentTree?.ticketId === tree.ticketId;
    if (keepBranch) {
      const set = readPreservedBranches();
      set.add(tree.branch);
      writePreservedBranches(set);
    }
    await ctx.stateManager.removeTree(tree.repoPath, tree.ticketId);
    try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.ticketId)); } catch {}
    ctx.outputChannel.appendLine('[Forest] State updated');
    if (shouldClose) {
      // Can't do git cleanup here — removing the worktree kills the extension host.
      // The main window's state watcher handles it (extension.ts onDidChange).
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    } else {
      await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path));
      if (!keepBranch) {
        await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch));
      }
    }
  } finally {
    teardownInProgress.delete(key);
  }
}

export async function cleanup(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = resolveTree(ctx, ticketIdArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to clean up. Run from a tree window or select from sidebar.');
    return;
  }
  const config = ctx.config;

  const confirm = await vscode.window.showWarningMessage(
    `Cleanup ${tree.ticketId}: ${tree.title}?\n\nThis will merge PR, remove worktree, and clean up.`,
    { modal: true }, 'Cleanup',
  );
  if (confirm !== 'Cleanup') return;

  if (await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showErrorMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cleaning up ${tree.ticketId}...` },
    async (progress) => {
      if (config.github.enabled && await gh.isAvailable()) {
        progress.report({ message: 'Merging PR...' });
        if (!await runStep(ctx, 'Merge PR', () => gh.mergePR(tree.path))) return;
      }

      progress.report({ message: 'Updating ticket...' });
      await updateLinear(ctx, tree.ticketId, config.linear.statuses.onCleanup);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

export async function cancel(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = resolveTree(ctx, ticketIdArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to cancel. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Cancel ${tree.ticketId}: ${tree.title}?\n\nThis will remove the worktree and branch without merging.`,
    { modal: true }, 'Cancel Tree',
  );
  if (confirm !== 'Cancel Tree') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Canceling ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Updating ticket...' });
      await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCancel);

      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree);
    },
  );
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCleanup);
  await teardownTree(ctx, tree);
}

export async function shelve(ctx: ForestContext, ticketIdArg?: string): Promise<void> {
  const tree = resolveTree(ctx, ticketIdArg);

  if (!tree) {
    vscode.window.showErrorMessage('No tree to shelve. Run from a tree window or select from sidebar.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Shelve ${tree.ticketId}: ${tree.title}?\n\nThis will remove the worktree but keep the branch.`,
    { modal: true }, 'Shelve',
  );
  if (confirm !== 'Shelve') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Shelving ${tree.ticketId}...` },
    async (progress) => {
      progress.report({ message: 'Removing worktree...' });
      await teardownTree(ctx, tree, true);
    },
  );
}
