import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import * as git from '../cli/git';
import * as linear from '../cli/linear';
import { createTree, updateLinear } from './shared';
import { getRepoPath } from '../context';

/** Try to extract a ticketId from a branch name using the configured branchFormat.
 *  e.g. branchFormat="${ticketId}-${slug}", branch="ENG-123-fix-login" → "ENG-123" */
function parseTicketId(branch: string, branchFormat: string): string | undefined {
  // Build a regex from branchFormat by replacing placeholders with capture groups.
  // ${ticketId} → named group, ${slug} → wildcard match.
  let pattern = branchFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  pattern = pattern
    .replace('\\$\\{ticketId\\}', '(?<ticketId>[A-Z]+-\\d+)')
    .replace('\\$\\{slug\\}', '.+');
  try {
    const match = new RegExp(`^${pattern}$`).exec(branch);
    return match?.groups?.ticketId;
  } catch { return undefined; }
}

export async function newTreeFromBranch(ctx: ForestContext): Promise<void> {
  const config = ctx.config;
  const repoPath = getRepoPath();

  // 1. Pick a branch
  const branches = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading branches...' },
    () => git.listBranches(repoPath, config.baseBranch),
  );

  if (!branches.length) {
    vscode.window.showInformationMessage('No branches available (all are already in worktrees or only the base branch exists).');
    return;
  }

  // Filter out branches that already have a tree in state
  const state = await ctx.stateManager.load();
  const existingBranches = new Set(
    ctx.stateManager.getTreesForRepo(state, repoPath).map(t => t.branch),
  );
  const available = branches.filter(b => !existingBranches.has(b));

  if (!available.length) {
    vscode.window.showInformationMessage('All branches already have trees.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    available.map(b => ({ label: b })),
    { placeHolder: 'Select a branch' },
  );
  if (!picked) return;
  const branch = picked.label;

  // 2. Resolve ticketId and title
  let ticketId: string | undefined;
  let title: string | undefined;
  let linkedLinear = false;
  const linearEnabled = config.linear.enabled && linear.isAvailable();

  // Try parsing ticketId from branch name
  ticketId = parseTicketId(branch, config.branchFormat);

  if (ticketId && linearEnabled) {
    // Verify ticket exists in Linear and fetch title
    const issue = await linear.getIssue(ticketId);
    if (issue) {
      title = issue.title;
      linkedLinear = true;
    } else {
      // Parsed something but it's not a real Linear ticket
      ticketId = undefined;
    }
  }

  if (!ticketId && linearEnabled) {
    // Ask user how to handle Linear
    const choice = await vscode.window.showQuickPick([
      { label: '$(search) Select from my issues', id: 'select' },
      { label: '$(add) Create new issue', id: 'create' },
      { label: '$(dash) Skip — no Linear ticket', id: 'skip' },
    ], { placeHolder: 'Link a Linear ticket?' });
    if (!choice) return;

    if (choice.id === 'select') {
      const issues = await linear.listMyIssues(config.linear.statuses.issueList, config.linear.team);
      // Filter out issues that already have trees
      const existingTickets = new Set(
        ctx.stateManager.getTreesForRepo(state, repoPath).map(t => t.ticketId),
      );
      const availableIssues = issues.filter(i => !existingTickets.has(i.id));
      if (!availableIssues.length) { vscode.window.showInformationMessage('No unlinked issues found.'); return; }
      const pick = await vscode.window.showQuickPick(
        availableIssues.map(i => ({ label: `${i.id}  ${i.title}`, description: i.state, issueId: i.id, issueTitle: i.title })),
        { placeHolder: 'Select an issue' },
      ) as any;
      if (!pick) return;
      ticketId = pick.issueId;
      title = pick.issueTitle;
      linkedLinear = true;
    } else if (choice.id === 'create') {
      const issueTitle = await vscode.window.showInputBox({ prompt: 'Issue title' });
      if (!issueTitle) return;
      const priority = await vscode.window.showQuickPick(
        [{ label: 'Urgent', value: 1 }, { label: 'High', value: 2 }, { label: 'Normal', value: 3 }, { label: 'Low', value: 4 }],
        { placeHolder: 'Priority (optional — Enter to skip)' },
      ) as any;
      try {
        ticketId = await linear.createIssue({ title: issueTitle, priority: priority?.value, team: config.linear.team });
        const issue = await linear.getIssue(ticketId);
        title = issue?.title ?? issueTitle;
        linkedLinear = true;
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to create Linear issue: ${e.message}`);
        return;
      }
    } else {
      // Skip — use branch name as ticketId
      ticketId = branch;
      title = branch;
    }
  }

  // Non-Linear fallback
  if (!ticketId) {
    ticketId = branch;
    title = branch;
  }
  if (!title) title = ticketId;

  // 3. Check for duplicate ticketId
  if (ctx.stateManager.getTree(state, repoPath, ticketId)) {
    const choice = await vscode.window.showWarningMessage(
      `Tree for ${ticketId} already exists.`, 'Switch to it', 'Cancel',
    );
    if (choice === 'Switch to it') {
      await vscode.commands.executeCommand('forest.switch', ticketId);
    }
    return;
  }

  // 4. Create tree
  try {
    await createTree({ ticketId, title, config, stateManager: ctx.stateManager, existingBranch: branch });
    if (linkedLinear) {
      await updateLinear(ctx, ticketId, config.linear.statuses.onNew);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
  }
}
