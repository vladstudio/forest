import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import * as linear from '../cli/linear';
import { createTree, updateLinear, pickTeam } from './shared';
import { slugify } from '../utils/slug';
import { getRepoPath } from '../context';

const BAD_BRANCH_CHARS = /[<>:"|?*\x00-\x1f\s~^\\]/;
function validateBranch(value: string): string | undefined {
  if (!value) return 'Branch name is required';
  if (BAD_BRANCH_CHARS.test(value)) return 'Branch name contains invalid characters';
  return undefined;
}

/** Try to extract a ticketId from a branch name using the configured branchFormat. */
function parseTicketId(branch: string, branchFormat: string): string | undefined {
  let pattern = branchFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  pattern = pattern
    .replace('\\$\\{ticketId\\}', '(?<ticketId>[A-Z]+-\\d+)')
    .replace('\\$\\{slug\\}', '.+');
  try {
    return new RegExp(`^${pattern}$`).exec(branch)?.groups?.ticketId;
  } catch { return undefined; }
}

/** Start working on a todo issue — creates branch + worktree. */
export async function start(ctx: ForestContext, arg: { ticketId: string; title: string }): Promise<void> {
  const config = ctx.config;
  const { ticketId, title } = arg;

  // Generate branch name from format
  const defaultBranch = config.branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slugify(title));

  const choice = await vscode.window.showQuickPick([
    { label: `$(git-branch) New branch: ${defaultBranch}`, id: 'new' },
    { label: '$(list-tree) Use existing branch', id: 'existing' },
  ], { placeHolder: `Start ${ticketId}: ${title}` });
  if (!choice) return;

  let branch: string;
  let existingBranch = false;

  if (choice.id === 'existing') {
    const branches = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading branches...' },
      () => git.listBranches(getRepoPath(), config.baseBranch),
    );
    const state = await ctx.stateManager.load();
    const usedBranches = new Set(ctx.stateManager.getTreesForRepo(state, getRepoPath()).map(t => t.branch));
    const available = branches.filter(b => !usedBranches.has(b));
    if (!available.length) { vscode.window.showInformationMessage('No available branches.'); return; }
    const picked = await vscode.window.showQuickPick(
      available.map(b => ({ label: b })),
      { placeHolder: 'Select a branch' },
    );
    if (!picked) return;
    branch = picked.label;
    existingBranch = true;
  } else {
    const edited = await vscode.window.showInputBox({
      prompt: 'Branch name',
      value: defaultBranch,
      validateInput: validateBranch,
    });
    if (!edited) return;
    branch = edited;
  }

  try {
    await createTree({ branch, config, stateManager: ctx.stateManager, ticketId, title, existingBranch });
    await updateLinear(ctx, ticketId, config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}

/** Unified creation wizard (the [+] button). */
export async function create(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const linearEnabled = config.linear.enabled && linear.isAvailable();

  const items: { label: string; id: string }[] = []
  if (linearEnabled) {
    items.push({ label: '$(add) New Linear issue + branch', id: 'issue' });
  }
  items.push({ label: '$(add) New branch', id: 'new' });
  items.push({ label: '$(git-branch) Existing branch', id: 'existing' });

  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Create a new tree' });
  if (!choice) return;

  if (choice.id === 'issue') {
    await createFromNewIssue(ctx);
  } else if (choice.id === 'existing') {
    await createFromExistingBranch(ctx);
  } else {
    await createFromNewBranch(ctx);
  }
}

async function createFromNewBranch(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const linearEnabled = config.linear.enabled && linear.isAvailable();

  const branchName = await vscode.window.showInputBox({ prompt: 'Branch name', placeHolder: 'my-feature', validateInput: validateBranch });
  if (!branchName) return;

  // Optional: link a Linear ticket
  let ticketId: string | undefined;
  let title: string | undefined;

  if (linearEnabled) {
    const link = await vscode.window.showQuickPick([
      { label: '$(search) Link to existing issue', id: 'select' },
      { label: '$(dash) No ticket', id: 'skip' },
    ], { placeHolder: 'Link a Linear ticket?' });
    if (!link) return;

    if (link.id === 'select') {
      const result = await pickIssue(ctx);
      if (result === undefined) return;
      if (result) { ticketId = result.ticketId; title = result.title; }
    }
  }

  try {
    await createTree({ branch: branchName, config, stateManager: ctx.stateManager, ticketId, title });
    if (ticketId) await updateLinear(ctx, ticketId, config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}

async function createFromExistingBranch(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const repoPath = getRepoPath();
  const linearEnabled = config.linear.enabled && linear.isAvailable();

  const branches = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading branches...' },
    () => git.listBranches(repoPath, config.baseBranch),
  );

  const state = await ctx.stateManager.load();
  const usedBranches = new Set(ctx.stateManager.getTreesForRepo(state, repoPath).map(t => t.branch));
  const available = branches.filter(b => !usedBranches.has(b));
  if (!available.length) { vscode.window.showInformationMessage('No available branches.'); return; }

  const picked = await vscode.window.showQuickPick(
    available.map(b => ({ label: b })),
    { placeHolder: 'Select a branch' },
  );
  if (!picked) return;
  const branch = picked.label;

  // Try to auto-detect ticket from branch name
  let ticketId: string | undefined;
  let title: string | undefined;
  let linkedLinear = false;

  ticketId = parseTicketId(branch, config.branchFormat);
  if (ticketId && linearEnabled) {
    const issue = await linear.getIssue(ticketId);
    if (issue) {
      title = issue.title;
      linkedLinear = true;
    } else {
      ticketId = undefined;
    }
  }

  if (!ticketId && linearEnabled) {
    const link = await vscode.window.showQuickPick([
      { label: '$(search) Link to existing issue', id: 'select' },
      { label: '$(add) Create new issue', id: 'create' },
      { label: '$(dash) No ticket', id: 'skip' },
    ], { placeHolder: 'Link a Linear ticket?' });
    if (!link) return;

    if (link.id === 'select') {
      const result = await pickIssue(ctx);
      if (result === undefined) return;
      if (result) { ticketId = result.ticketId; title = result.title; linkedLinear = true; }
    } else if (link.id === 'create') {
      const result = await createIssue(ctx);
      if (!result) return;
      ticketId = result.ticketId;
      title = result.title;
      linkedLinear = true;
    }
  }

  try {
    await createTree({ branch, config, stateManager: ctx.stateManager, ticketId, title, existingBranch: true });
    if (linkedLinear && ticketId) await updateLinear(ctx, ticketId, config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}

async function createFromNewIssue(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const result = await createIssue(ctx);
  if (!result) return;

  const { ticketId, title } = result;
  const defaultBranch = config.branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slugify(title));

  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name',
    value: defaultBranch,
    validateInput: validateBranch,
  });
  if (!branch) return;

  try {
    await createTree({ branch, config, stateManager: ctx.stateManager, ticketId, title });
    await updateLinear(ctx, ticketId, config.linear.statuses.onNew);
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}

async function pickIssue(ctx: ForestContext): Promise<{ ticketId: string; title: string } | null | undefined> {
  const issues = await linear.listMyIssues(ctx.config.linear.statuses.issueList, ctx.config.linear.teams);
  const state = await ctx.stateManager.load();
  const existingTickets = new Set(
    ctx.stateManager.getTreesForRepo(state, getRepoPath())
      .filter(t => t.ticketId)
      .map(t => t.ticketId),
  );
  const available = issues.filter(i => !existingTickets.has(i.id));
  if (!available.length) { vscode.window.showInformationMessage('No unlinked issues found.'); return null; }

  const pick = await vscode.window.showQuickPick(
    available.map(i => ({ label: `${i.id}  ${i.title}`, description: i.state, issueId: i.id, issueTitle: i.title })),
    { placeHolder: 'Select an issue' },
  ) as any;
  if (!pick) return undefined;
  return { ticketId: pick.issueId, title: pick.issueTitle };
}

async function createIssue(ctx: ForestContext): Promise<{ ticketId: string; title: string } | null> {
  const config = ctx.config;
  const issueTitle = await vscode.window.showInputBox({ prompt: 'Issue title', placeHolder: 'Fix team invite email validation' });
  if (!issueTitle) return null;

  const priority = await vscode.window.showQuickPick(
    [{ label: 'Urgent', value: 1 }, { label: 'High', value: 2 }, { label: 'Normal', value: 3 }, { label: 'Low', value: 4 }],
    { placeHolder: 'Priority (optional — Enter to skip)' },
  ) as any;

  const team = await pickTeam(config.linear.teams);
  if (!team) return null;

  try {
    const ticketId = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating Linear issue...', cancellable: false },
      async () => {
        const id = await linear.createIssue({ title: issueTitle, priority: priority?.value, team });
        return id;
      },
    );
    const issue = await linear.getIssue(ticketId);
    return { ticketId, title: issue?.title ?? issueTitle };
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to create Linear issue: ${e.message}`);
    return null;
  }
}
