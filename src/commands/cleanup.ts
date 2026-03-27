import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import type { TreeState } from '../state';
import { displayName } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { deleteWorkspaceFiles, requireTree, runStep, updateLinear } from './shared';
import { log } from '../logger';

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
      // Non-fatal: worktree is already gone so always clean up state regardless
      await runStep(ctx, 'Delete branch', () => git.deleteBranch(tree.repoPath, tree.branch, { skipRemote: !opts.deleteRemote }));
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

export type DeleteBranchAction = 'keep' | 'local' | 'all';
export type DeleteLinearAction = 'none' | 'cancel' | 'cleanup';
export type DeletePrAction = 'none' | 'close';

export interface DeletePlan {
  branches: DeleteBranchAction;
  linear: DeleteLinearAction;
  pr: DeletePrAction;
}

function defaultLinearAction(prState?: string | null): DeleteLinearAction {
  return prState === 'MERGED' ? 'cleanup' : 'cancel';
}

function branchesToTeardownOpts(branches: DeleteBranchAction): TeardownOpts {
  return {
    deleteLocal: branches === 'local' || branches === 'all',
    deleteRemote: branches === 'all',
  };
}

function linearStatusForPlan(ctx: ForestContext, plan: DeletePlan): string | undefined {
  if (plan.linear === 'cleanup') return ctx.config.linear.statuses.onCleanup;
  if (plan.linear === 'cancel') return ctx.config.linear.statuses.onCancel;
  return undefined;
}

async function fallbackDeletePlan(
  ctx: ForestContext,
  tree: TreeState & { path: string },
  prState?: string | null,
): Promise<DeletePlan | undefined> {
  const defaultBranches: DeleteBranchAction = 'all';
  const defaultLinear = defaultLinearAction(prState);
  const defaultPr: DeletePrAction = prState === 'OPEN' ? 'close' : 'none';

  const branchPick = await vscode.window.showQuickPick(
    [
      { label: 'Delete local + remote (default)', action: 'all' as const },
      { label: 'Delete local only', action: 'local' as const },
      { label: 'Keep branches', action: 'keep' as const },
    ],
    {
      title: `Delete ${displayName(tree)}`,
      placeHolder: 'What should happen to branches?',
    },
  );
  if (!branchPick) return undefined;

  let linearAction: DeleteLinearAction = 'none';
  if (tree.ticketId && ctx.config.linear.enabled) {
    const defaultStatus = defaultLinear === 'cleanup'
      ? ctx.config.linear.statuses.onCleanup
      : ctx.config.linear.statuses.onCancel;
    const linearPick = await vscode.window.showQuickPick(
      [
        {
          label: `${defaultLinear === 'cleanup' ? 'Move ticket to done' : 'Cancel ticket'} (default)`,
          detail: `Move ${tree.ticketId} → ${defaultStatus}`,
          action: defaultLinear,
        },
        {
          label: 'Do nothing',
          detail: `Keep ${tree.ticketId} unchanged`,
          action: 'none' as const,
        },
      ],
      { placeHolder: 'What should happen to the Linear ticket?' },
    );
    if (!linearPick) return undefined;
    linearAction = linearPick.action;
  }

  let prAction: DeletePrAction = 'none';
  if (prState === 'OPEN') {
    const prPick = await vscode.window.showQuickPick(
      [
        { label: defaultPr === 'close' ? 'Close PR (default)' : 'Close PR', action: 'close' as const },
        { label: 'Do nothing', action: 'none' as const },
      ],
      { placeHolder: 'What should happen to the pull request?' },
    );
    if (!prPick) return undefined;
    prAction = prPick.action;
  }

  return {
    branches: branchPick.action ?? defaultBranches,
    linear: linearAction,
    pr: prAction,
  };
}

export async function executeDeletePlan(
  ctx: ForestContext,
  tree: TreeState & { path: string },
  plan: DeletePlan,
): Promise<boolean> {
  const name = displayName(tree);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${name}...` },
    async (progress) => {
      if (plan.pr === 'close') {
        progress.report({ message: 'Closing PR...' });
        const closed = await runStep(ctx, 'Close PR', () => gh.closePR(tree.repoPath, tree.branch));
        if (!closed) return false;
      }

      progress.report({ message: 'Removing tree...' });
      const removed = await teardownTree(ctx, tree, branchesToTeardownOpts(plan.branches));
      if (!removed) return false;

      const linearStatus = linearStatusForPlan(ctx, plan);
      if (tree.ticketId && linearStatus) {
        progress.report({ message: 'Updating ticket...' });
        await updateLinear(ctx, tree.ticketId, linearStatus);
      }

      return true;
    },
  );
}

export async function deleteTree(ctx: ForestContext, branchArg?: string, isDone?: boolean): Promise<void> {
  const tree = requireTree(ctx, branchArg, 'delete');
  if (!tree) return;
  if (tree.busyOperation) {
    vscode.window.showInformationMessage(`${displayName(tree)} is already ${tree.busyOperation}.`);
    return;
  }

  if (ctx.forestProvider.showDeleteForm && await ctx.forestProvider.showDeleteForm(tree.branch)) return;

  const prState = ctx.config.github.enabled
    ? (await gh.prStatus(tree.path).catch(() => null))?.state ?? null
    : null;
  const plan = await fallbackDeletePlan(ctx, tree, isDone && prState !== 'CLOSED' ? 'MERGED' : prState);
  if (!plan) return;
  await executeDeletePlan(ctx, tree, plan);
}
