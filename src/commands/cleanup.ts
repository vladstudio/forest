import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { getRepoPath } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import { deleteWorkspaceFiles, runStep, updateLinear } from './shared';
import { log } from '../logger';

function requireTree(ctx: ForestContext, branchArg: string | undefined, action: string): TreeState | undefined {
  const tree = branchArg
    ? ctx.stateManager.getTree(ctx.stateManager.loadSync(), getRepoPath(), branchArg)
    : ctx.currentTree;
  if (!tree) vscode.window.showErrorMessage(`No tree to ${action}. Run from a tree window or select from sidebar.`);
  return tree;
}

const teardownInProgress = new Set<string>();

interface TeardownOpts {
  deleteLocal?: boolean;
  deleteRemote?: boolean;
}

async function teardownTree(ctx: ForestContext, tree: TreeState, opts: TeardownOpts = {}): Promise<boolean> {
  const key = `${tree.repoPath}:${tree.branch}`;
  if (teardownInProgress.has(key)) { log.warn(`teardownTree already in progress: ${tree.branch}`); return false; }
  log.info(`teardownTree: ${tree.branch}`);
  teardownInProgress.add(key);
  let removedFromState = false;
  const clearCleaning = () => ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
  try {
    await ctx.stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: true });
    const shouldClose = ctx.currentTree?.branch === tree.branch;
    if (tree.path) {
      const removed = await runStep(ctx, 'Remove worktree', () => git.removeWorktree(tree.repoPath, tree.path!));
      if (!removed) {
        // Fail closed: keep the tree in state so the user can retry cleanup.
        await clearCleaning();
        return false;
      }
    }
    if (opts.deleteLocal) {
      const deleted = await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch, { skipRemote: !opts.deleteRemote }));
      if (!deleted) {
        // Branch deletion is destructive too; don't forget the tree on partial failure.
        await clearCleaning();
        return false;
      }
    }
    await ctx.stateManager.removeTree(tree.repoPath, tree.branch);
    removedFromState = true;
    deleteWorkspaceFiles(tree);
    ctx.outputChannel.appendLine('[Forest] State updated');
    if (shouldClose) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
    return true;
  } catch (e) {
    if (!removedFromState) {
      await clearCleaning().catch(() => {});
    }
    throw e;
  } finally {
    teardownInProgress.delete(key);
  }
}

/** Cleanup after an already-merged PR — skips merge and confirmation. */
export async function cleanupMerged(ctx: ForestContext, tree: TreeState): Promise<void> {
  if (tree.path && await git.hasUncommittedChanges(tree.path)) {
    vscode.window.showWarningMessage('Tree has uncommitted changes. Commit or discard first.');
    return;
  }
  if (!await teardownTree(ctx, tree, { deleteLocal: true, deleteRemote: true })) return;
  if (tree.ticketId) await updateLinear(ctx, tree.ticketId, ctx.config.linear.statuses.onCleanup);
}

interface DeleteOption extends vscode.QuickPickItem {
  deleteLocal: boolean;
  deleteRemote: boolean;
  cancelTicket: boolean;
}

export async function deleteTree(ctx: ForestContext, branchArg?: string, isDone?: boolean): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'delete');
  if (!tree) return;

  const name = displayName(tree);
  const hasLinear = !!tree.ticketId && ctx.config.linear.enabled && !isDone;

  const options: DeleteOption[] = [
    ...(hasLinear ? [{
      label: '$(circle-slash) Delete branches · cancel ticket',
      detail: `Remove worktree + all branches · move ${tree.ticketId} → ${ctx.config.linear.statuses.onCancel}`,
      deleteLocal: true, deleteRemote: true, cancelTicket: true,
    }] : []),
    {
      label: '$(close-all) Delete branches',
      detail: 'Remove worktree + all branches' + (hasLinear ? ' · keep ticket' : ''),
      deleteLocal: true, deleteRemote: true, cancelTicket: false,
    },
    {
      label: '$(trash) Delete local branch',
      detail: 'Remove worktree + local branch' + (hasLinear ? ' · keep remote & ticket' : ''),
      deleteLocal: true, deleteRemote: false, cancelTicket: false,
    },
    {
      label: '$(archive) Keep branches',
      detail: 'Remove worktree only' + (hasLinear ? ' · keep branches & ticket' : ''),
      deleteLocal: false, deleteRemote: false, cancelTicket: false,
    },
  ];

  const picked = await vscode.window.showQuickPick(options, {
    title: `Delete ${name}`,
    placeHolder: 'Select what to delete',
  });
  if (!picked) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${name}...` },
    async (progress) => {
      progress.report({ message: 'Removing tree...' });
      if (!await teardownTree(ctx, tree, { deleteLocal: picked.deleteLocal, deleteRemote: picked.deleteRemote })) return;
      if (picked.cancelTicket) {
        progress.report({ message: 'Updating ticket...' });
        await updateLinear(ctx, tree.ticketId!, ctx.config.linear.statuses.onCancel);
      }
    },
  );
}
