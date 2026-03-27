import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ForestConfig } from '../config';
import type { ForestContext } from '../context';
import { displayName, type StateManager, type TreeState } from '../state';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import * as ai from '../cli/ai';
import { shortBaseBranch, slugify } from '../utils/slug';
import { copyConfigFiles, createTree, ensureTreeIdle, ensureWorkspaceFile, focusOrOpenWindow, getBlockingTreeOperation, updateLinear, withTreeOperation } from '../commands/shared';
import { executeDeletePlan, type DeletePlan } from '../commands/cleanup';
import { pickIssue } from '../commands/create';
import { log } from '../logger';

interface TreeCardData {
  key: string;
  branch: string;
  path?: string;
  ticketId?: string;
  ticketTitle?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  behind: number;
  ahead: number;
  localChanges: { added: number; removed: number; modified: number } | null;
  isCurrent: boolean;
  cleaning: boolean;
  busyOperation?: string;
}

interface WebviewData {
  repoName: string;
  baseBranch: string;
  mainIsCurrent: boolean;
  hasAI: boolean;
  linearEnabled: boolean;
  groups: Array<{ label: string; trees: TreeCardData[] }>;
}

function gitRefUri(filePath: string, ref: string): vscode.Uri {
  const fileUri = vscode.Uri.file(filePath);
  return fileUri.with({
    scheme: 'git',
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}

/** Maps a TreeState to the base fields shared by all card states. */
function baseCard(t: TreeState, isCurrent: boolean): TreeCardData {
  return {
    key: `${t.repoPath}:${t.branch}`,
    branch: t.branch, path: t.path,
    ticketId: t.ticketId, ticketTitle: t.title,
    behind: 0, ahead: 0, localChanges: null,
    isCurrent, cleaning: false, busyOperation: t.busyOperation,
  };
}

export class ForestWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ctx?: ForestContext;
  private dataCache = new Map<string, { data: Promise<TreeCardData>; time: number }>();
  private readonly CACHE_TTL = 30_000;

  constructor(
    private readonly stateManager: StateManager,
    private readonly config: ForestConfig,
  ) { }

  setContext(ctx: ForestContext): void { this.ctx = ctx; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    view.onDidChangeVisibility(() => { if (view.visible) this.update(); });
    this.update();
  }

  refresh(): void {
    this.dataCache.clear();
    this.update();
  }

  refreshTrees(): void { this.refresh(); }

  async showCreateForm(): Promise<void> {
    if (!this.view || !this.ctx) return;
    const repoPath = getRepoPath();
    const localChanges = await git.localChanges(repoPath).catch(() => null);
    const uncommittedCount = localChanges ? localChanges.added + localChanges.removed + localChanges.modified : 0;
    this.postMessage({
      type: 'showCreateForm',
      init: {
        linearEnabled: this.config.linear.enabled && linear.isAvailable(),
        teams: this.config.linear.teams ?? [],
        uncommittedCount,
        branchFormat: this.config.branchFormat,
      },
    });
  }

  async showDeleteForm(branchArg?: string): Promise<boolean> {
    if (!this.view?.visible || !this.ctx) return false;
    const repoPath = getRepoPath();
    const branch = branchArg ?? this.ctx.currentTree?.branch;
    if (!branch) return false;

    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);
    if (!tree?.path) return false;
    const active = await getBlockingTreeOperation(this.ctx, tree);
    if (active) {
      vscode.window.showInformationMessage(`${displayName(tree)} is already ${active}.`);
      return true;
    }

    const pr = this.config.github.enabled ? await gh.prStatus(tree.path).catch(() => null) : null;
    const defaultLinearAction = pr?.state === 'MERGED' ? 'cleanup' : 'cancel';
    this.postMessage({
      type: 'showDeleteForm',
      init: {
        key: `${tree.repoPath}:${tree.branch}`,
        name: displayName(tree),
        branch: tree.branch,
        ticketId: tree.ticketId ?? null,
        ticketTitle: tree.title ?? null,
        linearEnabled: this.config.linear.enabled && !!tree.ticketId,
        prState: pr?.state ?? null,
        prNumber: pr?.number ?? null,
        defaultBranches: 'all',
        defaultLinearAction,
        defaultPrAction: pr?.state === 'OPEN' ? 'close' : 'none',
        cancelStatusName: this.config.linear.statuses.onCancel,
        cleanupStatusName: this.config.linear.statuses.onCleanup,
      },
    });
    return true;
  }

  private postMessage(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private async update(): Promise<void> {
    if (!this.view?.visible) return;
    try {
      const data = await this.buildData();
      this.view.webview.postMessage({ type: 'update', data });
    } catch (e: any) {
      log.error(`ForestWebviewProvider.update: ${e.message}`);
    }
  }

  private getTreeData(tree: TreeState): Promise<TreeCardData> {
    const key = `${tree.repoPath}:${tree.branch}`;
    const cached = this.dataCache.get(key);
    if (cached && Date.now() - cached.time < this.CACHE_TTL) return cached.data;
    const data = this.fetchTreeData(tree);
    this.dataCache.set(key, { data, time: Date.now() });
    data.catch(() => this.dataCache.delete(key));
    return data;
  }

  private async fetchTreeData(tree: TreeState): Promise<TreeCardData> {
    const base = baseCard(tree, false);
    if (!tree.path || !fs.existsSync(tree.path)) return base;

    const [behind, ahead, pr, localChanges] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, tree.branch),
      this.config.github.enabled ? gh.prStatus(tree.path) : Promise.resolve(null),
      git.localChanges(tree.path),
    ]);

    if (pr?.url && !tree.prUrl) {
      this.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: pr.url }).catch(() => { });
    }

    return { ...base, prNumber: pr?.number, prUrl: pr?.url ?? tree.prUrl, prState: pr?.state, behind, ahead, localChanges };
  }

  private async buildData(): Promise<WebviewData> {
    const repoPath = getRepoPath();
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const cardResults = await Promise.all(
      trees.map(t => t.cleaning ? Promise.resolve(null) : this.getTreeData(t).catch(() => null)),
    );

    const cleaning: TreeCardData[] = [];
    const inProgress: TreeCardData[] = [];
    const inReview: TreeCardData[] = [];
    const done: TreeCardData[] = [];
    const closed: TreeCardData[] = [];

    trees.forEach((t, i) => {
      const isCurrent = t.path === curPath;
      if (t.cleaning) {
        cleaning.push({ ...baseCard(t, isCurrent), cleaning: true });
        return;
      }
      const card = cardResults[i];
      if (!card) return;
      card.isCurrent = isCurrent;
      card.busyOperation = t.busyOperation;
      const s = card.prState;
      if (s === 'MERGED') done.push(card);
      else if (s === 'CLOSED') closed.push(card);
      else if (card.prNumber) inReview.push(card);
      else inProgress.push(card);
    });

    const groups: WebviewData['groups'] = [];
    if (cleaning.length) groups.push({ label: 'Cleaning up', trees: cleaning });
    if (inProgress.length) groups.push({ label: 'In progress', trees: inProgress });
    if (inReview.length) groups.push({ label: 'In review', trees: inReview });
    if (done.length) groups.push({ label: 'Done', trees: done });
    if (closed.length) groups.push({ label: 'Closed', trees: closed });

    return {
      repoName: path.basename(repoPath),
      baseBranch: shortBaseBranch(this.config.baseBranch),
      mainIsCurrent: curPath === repoPath,
      hasAI: !!this.config.ai,
      linearEnabled: this.config.linear.enabled,
      groups,
    };
  }

  private async openBaseDiff(tree: TreeState): Promise<void> {
    if (!tree.path) return;
    const { mergeBase, changes } = await git.diffFilesFromBase(tree.path, this.config.baseBranch);
    await this.openRefDiff(tree, {
      title: 'branch diff',
      leftRef: mergeBase,
      rightRef: 'HEAD',
      changes,
      emptyMessage: `No branch changes from ${shortBaseBranch(this.config.baseBranch)}.`,
      sourcePath: `${tree.path}/${mergeBase}...HEAD`,
    });
  }

  private async openMainDiff(tree: TreeState): Promise<void> {
    if (!tree.path) return;
    const changes = await git.diffFilesBetweenRefs(tree.path, this.config.baseBranch, 'HEAD');
    await this.openRefDiff(tree, {
      title: 'main diff',
      leftRef: this.config.baseBranch,
      rightRef: 'HEAD',
      changes,
      emptyMessage: `No differences between ${shortBaseBranch(this.config.baseBranch)} and this branch.`,
      sourcePath: `${tree.path}/${this.config.baseBranch}..HEAD`,
    });
  }

  private async openRefDiff(
    tree: TreeState,
    opts: {
      title: string;
      leftRef: string;
      rightRef: string;
      changes: git.DiffFileChange[];
      emptyMessage: string;
      sourcePath: string;
    },
  ): Promise<void> {
    if (!tree.path) return;
    if (!opts.changes.length) {
      vscode.window.showInformationMessage(opts.emptyMessage);
      return;
    }

    const resources = opts.changes.map(change => {
      switch (change.status) {
        case 'A':
          return {
            originalUri: undefined,
            modifiedUri: gitRefUri(path.join(tree.path!, change.path), opts.rightRef),
          };
        case 'D':
          return {
            originalUri: gitRefUri(path.join(tree.path!, change.path), opts.leftRef),
            modifiedUri: undefined,
          };
        case 'R':
        case 'C':
          return {
            originalUri: gitRefUri(path.join(tree.path!, change.originalPath!), opts.leftRef),
            modifiedUri: gitRefUri(path.join(tree.path!, change.path), opts.rightRef),
          };
        default:
          return {
            originalUri: gitRefUri(path.join(tree.path!, change.path), opts.leftRef),
            modifiedUri: gitRefUri(path.join(tree.path!, change.path), opts.rightRef),
          };
      }
    });

    try {
      await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
        multiDiffSourceUri: vscode.Uri.from({ scheme: 'forest-ref-compare', path: opts.sourcePath }),
        title: opts.title,
        resources,
      });
    } catch {
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  private async handleMessage(msg: Record<string, any>): Promise<void> {
    const { command, key } = msg;

    if (command === 'switchToMain') {
      focusOrOpenWindow(vscode.Uri.file(getRepoPath()));
      return;
    }

    // Create form commands (no key needed)
    if (command === 'pickBranch') {
      const branches = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading branches...' },
        () => git.listBranches(getRepoPath(), this.config.baseBranch),
      );
      if (!branches.length) {
        vscode.window.showInformationMessage('No available branches.');
        this.postMessage({ type: 'branchPickResult', branch: null });
        return;
      }
      const picked = await vscode.window.showQuickPick(
        branches.map(b => ({ label: b })),
        { placeHolder: 'Select a branch' },
      );
      this.postMessage({ type: 'branchPickResult', branch: picked?.label ?? null });
      return;
    }

    if (command === 'pickIssue') {
      if (!this.ctx) return;
      const result = await pickIssue(this.ctx);
      this.postMessage({ type: 'issuePickResult', issue: result ?? null });
      return;
    }

    if (command === 'createForm:submit') {
      await this.handleCreateSubmit(msg);
      return;
    }

    if (command === 'deleteForm:submit') {
      await this.handleDeleteSubmit(msg);
      return;
    }

    if (!key) return;
    const colonIdx = key.indexOf(':');
    const repoPath = key.slice(0, colonIdx);
    const branch = key.slice(colonIdx + 1);
    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);
    const ctx = this.ctx;

    const withProgress = async (busyOperation: string, title: string, fn: () => Promise<void>) => {
      if (!ctx || !tree?.path) return;
      await withTreeOperation(
        ctx,
        tree as TreeState & { path: string },
        busyOperation,
        () => vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title },
          async () => { try { await fn(); } catch (e: any) { vscode.window.showErrorMessage(`Forest: ${e.message}`); } },
        ),
      );
      this.refresh();
    };

    switch (command) {
      case 'pull':
        if (!tree?.path) return;
        await withProgress('pulling', 'Pulling...', () => git.pull(tree.path!));
        break;

      case 'push':
        if (!tree?.path) return;
        await withProgress('pushing', 'Pushing...', () => git.pushBranch(tree.path!, tree.branch));
        break;

      case 'mergeFromMain':
        if (!tree?.path) return;
        await withProgress('merging', 'Merging from main...', async () => {
          await git.pullMerge(tree.path!, this.config.baseBranch);
          copyConfigFiles(this.config, tree.repoPath, tree.path!);
        });
        break;

      case 'revealInFinder':
        if (tree?.path) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tree.path));
        break;

      case 'copyBranch':
        if (tree) vscode.env.clipboard.writeText(tree.branch);
        break;

      case 'openTicket': {
        if (!tree?.ticketId) return;
        const issue = await linear.getIssue(tree.ticketId).catch(() => null);
        if (issue?.url) vscode.env.openExternal(vscode.Uri.parse(issue.url));
        break;
      }

      case 'detachTicket':
        if (!tree) return;
        await this.stateManager.updateTree(repoPath, branch, { ticketId: undefined, title: undefined });
        this.refresh();
        break;

      case 'linkTicket':
        vscode.commands.executeCommand('forest.linkTicket', branch);
        break;

      case 'switch':
        if (tree?.path) focusOrOpenWindow(vscode.Uri.file(ensureWorkspaceFile(tree)));
        break;

      case 'workingDiff': {
        if (!tree || !tree.path) return;
        const hasChanges = await git.hasUncommittedChanges(tree.path);
        if (!hasChanges) { vscode.window.showInformationMessage('No working changes.'); return; }
        await vscode.commands.executeCommand('git.viewChanges', vscode.Uri.file(tree.path));
        break;
      }

      case 'branchDiff': {
        if (!tree || !tree.path) return;
        await this.openBaseDiff(tree);
        break;
      }

      case 'mainDiff': {
        if (!tree || !tree.path) return;
        await this.openMainDiff(tree);
        break;
      }

      case 'commit': {
        if (!tree || !tree.path || !this.config.ai) return;
        const commitDiff = await git.workingDiff(tree.path);
        if (!commitDiff.trim()) { vscode.window.showInformationMessage('No working changes to commit.'); return; }
        let message = '';
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Generating commit message...' },
            async () => {
              message = await ai.generateCommitMessage(this.config.ai!, commitDiff);
            },
          );
        } catch (e: any) {
          vscode.window.showErrorMessage(`Forest: ${e.message}`);
          return;
        }
        const confirmed = await vscode.window.showInputBox({
          value: message,
          prompt: 'Commit message — all changes will be staged',
          ignoreFocusOut: true,
        });
        if (!confirmed) return;
        await withProgress('committing', 'Committing...', () => git.commitAll(tree.path!, confirmed));
        break;
      }

      case 'discard': {
        if (!tree || !tree.path) return;
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Discard unstaged', id: 'unstaged' }, { label: 'Discard all (including staged)', id: 'all' }],
          { placeHolder: 'What to discard?' },
        );
        if (!pick) return;
        await withProgress('discarding', 'Discarding...', () =>
          pick.id === 'unstaged' ? git.discardUnstaged(tree.path!) : git.discardChanges(tree.path!),
        );
        break;
      }

      case 'ship':
        vscode.commands.executeCommand('forest.ship', branch);
        break;

      case 'delete':
        await this.showDeleteForm(branch);
        break;

      case 'openPR':
        if (tree?.prUrl) vscode.env.openExternal(vscode.Uri.parse(tree.prUrl));
        break;
    }
  }

  private async handleCreateSubmit(msg: Record<string, any>): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const repoPath = getRepoPath();

    try {
      let ticketId: string | undefined = msg.ticketId;
      let title: string | undefined = msg.ticketTitle;

      // Create new Linear issue if needed
      if (msg.ticketMode === 'new' && msg.newTicketTitle) {
        const team = msg.team || ctx.config.linear.teams?.[0];
        if (!team) {
          this.postMessage({ type: 'createResult', success: false, error: 'No Linear team configured.' });
          return;
        }
        try {
          ticketId = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Creating Linear issue...' },
            () => linear.createIssue({
              title: msg.newTicketTitle,
              priority: msg.priority || undefined,
              team,
            }),
          );
          title = msg.newTicketTitle;
        } catch (e: any) {
          this.postMessage({ type: 'createResult', success: false, error: `Failed to create issue: ${e.message}` });
          return;
        }
      }

      // Determine branch name
      let branch: string;
      if (msg.branchMode === 'existing') {
        branch = msg.existingBranch;
      } else if (ticketId && title && !msg.branchManuallyEdited) {
        // New ticket created — use branchFormat with real ticketId
        branch = ctx.config.branchFormat
          .replace('${ticketId}', ticketId)
          .replace('${slug}', slugify(title));
      } else {
        branch = msg.branchName;
      }

      if (!branch) {
        this.postMessage({ type: 'createResult', success: false, error: 'Branch name is required.' });
        return;
      }

      // Handle uncommitted changes
      let carryChanges: string | false = false;
      if (msg.carryChanges && await git.hasUncommittedChanges(repoPath)) {
        carryChanges = await git.stash(repoPath, `forest-carry-${Date.now()}`);
      }

      const newlyCreatedTicket = msg.ticketMode === 'new' && ticketId;

      try {
        await createTree({
          branch,
          config: ctx.config,
          stateManager: ctx.stateManager,
          ticketId,
          title,
          existingBranch: msg.branchMode === 'existing',
          carryChanges,
        });
      } catch (e: any) {
        // Revert Linear issue status if we just created it
        if (newlyCreatedTicket) {
          const revertStatus = ctx.config.linear.statuses.issueList[ctx.config.linear.statuses.issueList.length - 1];
          await updateLinear(ctx, ticketId!, revertStatus).catch(() => { });
        }
        throw e;
      }

      if (ticketId) {
        await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
      }

      this.postMessage({ type: 'createResult', success: true });
    } catch (e: any) {
      this.postMessage({ type: 'createResult', success: false, error: e.message });
    }
  }

  private async handleDeleteSubmit(msg: Record<string, any>): Promise<void> {
    if (!this.ctx || !msg.key) return;
    const ctx = this.ctx;
    const key = String(msg.key);
    const colonIdx = key.indexOf(':');
    if (colonIdx < 0) return;
    const repoPath = key.slice(0, colonIdx);
    const branch = key.slice(colonIdx + 1);
    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);

    if (!tree?.path) {
      this.postMessage({ type: 'deleteResult', success: false, error: 'Tree path is missing.' });
      return;
    }
    if (!await ensureTreeIdle(ctx, tree)) {
      this.postMessage({ type: 'deleteResult', success: false, error: `${displayName(tree)} is busy with another Git operation.` });
      return;
    }

    try {
      const plan: DeletePlan = {
        branches: msg.branches,
        linear: msg.linear,
        pr: msg.pr,
      };
      const success = await executeDeletePlan(ctx, tree as TreeState & { path: string }, plan);
      this.postMessage({
        type: 'deleteResult',
        success,
        error: success ? null : 'Delete was interrupted. Check notifications for details.',
      });
    } catch (e: any) {
      this.postMessage({ type: 'deleteResult', success: false, error: e.message });
    }
  }

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
#root { padding: 4px 0 8px; }
.empty { padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
.group { padding: 6px 12px 2px; font-size: 11px; text-transform: uppercase; opacity: 0.6; margin-top: 4px; }
.card { margin: 2px 8px; padding: 8px 10px; border: 1px solid var(--vscode-activityBar-border, rgba(128,128,128,0.2)); border-radius: 4px; background: transparent; }
.card.current { background: var(--vscode-editor-background); }
.card.card-main { display: flex; align-items: center; gap: 6px; margin: 4px 8px 6px; padding: 5px 10px; }
.card-label { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
.branch { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 3px; }
[data-cmd] { cursor: pointer; text-decoration: none; color: inherit; }
a[data-cmd] { color: var(--vscode-breadcrumb-foreground, inherit); }
a[data-cmd]:hover { opacity: 0.7; }
.row { display: flex; align-items: center; gap: 3px; margin-bottom: 5px; min-height: 20px; flex-wrap: wrap; }
.row:last-child { margin-bottom: 0; }
.dim { color: var(--vscode-descriptionForeground); font-size: 11px; }
.ticket { cursor: pointer; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ticket:hover { text-decoration: underline; }
.stats { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); flex: 1; white-space: nowrap; }
.add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
.del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
.mod { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
.icon { display: inline-flex; align-items: center; }
.icon svg { width: 14px; height: 14px; fill: currentColor; }
.icon svg[stroke] { fill: none; }
button { cursor: pointer; font-family: var(--vscode-font-family); border: none; border-radius: 3px; }
.btn { background: none; color: var(--vscode-foreground); padding: 2px 4px; font-size: 12px; border: 1px solid var(--vscode-activityBar-border, rgba(128,128,128,0.3)); opacity: 0.9; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 2px; min-height: 20px; text-align: center; }
.btn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.faint { opacity: 0.45; }
.btn.faint:hover:not(:disabled) { opacity: 0.8; }
.btn.danger { color: var(--vscode-errorForeground, #f44736) !important; }
.fill { flex: 1; }
.form { padding: 8px; }
.form-section { margin-bottom: 14px; }
.form-row { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.form-input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 6px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); outline: none; }
.form-input:focus { border-color: var(--vscode-focusBorder); }
.form-input::placeholder { color: var(--vscode-input-placeholderForeground); }
.form-select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 3px; padding: 3px 4px; font-family: var(--vscode-font-family); font-size: 11px; outline: none; flex: 1; }
.form-select:focus { border-color: var(--vscode-focusBorder); }
.form-value { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 3px; }
.form-hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.form-error { font-size: 11px; color: var(--vscode-errorForeground); margin-bottom: 6px; padding: 4px 8px; border-radius: 3px; }
.form-actions { display: flex; gap: 4px; margin-top: 12px; }
.btn-create { flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 8px; font-size: 12px; }
.btn-create:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.btn-create:disabled { opacity: 0.5; cursor: default; }
.btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 6px 12px; font-size: 12px; }
.btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn-toggle.active { background: var(--vscode-selection-background); color: var(--vscode-button-secondaryForeground); opacity: 1; }
.form-title { display: flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.form-copy { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
.radio-group { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.radio-option { display: flex; gap: 8px; padding: 8px; border: 1px solid var(--vscode-activityBar-border, rgba(128,128,128,0.2)); border-radius: 4px; background: transparent; cursor: pointer; }
.radio-option:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
.radio-option input { margin: 2px 0 0; accent-color: var(--vscode-button-background); }
.radio-option input:focus, .radio-option input:focus-visible { outline: none; box-shadow: none; }
.radio-option:focus-within { outline: none; }
.radio-option.disabled { opacity: 0.6; cursor: default; }
.radio-body { min-width: 0; flex: 1; }
.radio-title { font-size: 12px; }
</style>
</head>
<body>
<div id="root"><div style="display:flex;flex-direction:column;align-items:center;padding:32px;color:var(--vscode-descriptionForeground)"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;margin-bottom:8px"><path d="M6.5 10.75c.31 0 .587.19.7.479l3.5 9a.75.75 0 0 1-.7 1.021H3a.75.75 0 0 1-.7-1.021l3.5-9a.75.75 0 0 1 .7-.479ZM4.097 19.75h4.806L6.5 13.57l-2.403 6.18Z"/><path d="M17.5 10.75c.31 0 .587.19.7.479l3.5 9a.75.75 0 0 1-.7 1.021H14a.75.75 0 0 1-.7-1.021l3.5-9a.75.75 0 0 1 .7-.479Zm-2.403 9h4.806L17.5 13.57l-2.403 6.18Z"/><path d="M12 .75c.31 0 .587.19.7.479l3.5 9a.75.75 0 0 1-.7 1.021H8.5a.75.75 0 0 1-.7-1.021l3.5-9A.75.75 0 0 1 12 .75ZM9.597 9.75h4.806L12 3.57 9.597 9.75Z"/></svg><span style="font-size:11px">Loading…</span></div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let mode = 'list';
let latestData = null;
let formInit = null;
let formState = null;
let deleteInit = null;
let deleteState = null;

function defaultFormState(init) {
  return {
    branchMode: 'new',
    branchName: '',
    existingBranch: null,
    branchManuallyEdited: false,
    ticketMode: init.linearEnabled ? 'new' : 'none',
    ticketId: null,
    ticketTitle: null,
    newTicketTitle: '',
    priority: 2,
    team: init.teams && init.teams[0] || '',
    carryChanges: init.uncommittedCount > 0,
    submitting: false,
    error: null,
  };
}

function defaultDeleteState(init) {
  return {
    key: init.key,
    branches: init.defaultBranches,
    linear: init.defaultLinearAction,
    pr: init.defaultPrAction,
    submitting: false,
    error: null,
  };
}

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'update':
      latestData = msg.data;
      if (mode === 'list') renderCurrentMode();
      break;
    case 'showCreateForm':
      mode = 'create';
      formInit = msg.init;
      formState = defaultFormState(msg.init);
      renderCurrentMode();
      break;
    case 'showDeleteForm':
      mode = 'delete';
      deleteInit = msg.init;
      deleteState = defaultDeleteState(msg.init);
      renderCurrentMode();
      break;
    case 'branchPickResult':
      if (formState && msg.branch) {
        formState.branchMode = 'existing';
        formState.existingBranch = msg.branch;
      }
      renderCurrentMode();
      break;
    case 'issuePickResult':
      if (formState && msg.issue) {
        formState.ticketMode = 'existing';
        formState.ticketId = msg.issue.ticketId;
        formState.ticketTitle = msg.issue.title;
        autoFillBranch();
      }
      renderCurrentMode();
      break;
    case 'createResult':
      if (formState) {
        formState.submitting = false;
        if (msg.success) {
          mode = 'list';
        } else {
          formState.error = msg.error;
        }
        renderCurrentMode();
      }
      break;
    case 'deleteResult':
      if (deleteState) {
        deleteState.submitting = false;
        if (msg.success) {
          mode = 'list';
        } else {
          deleteState.error = msg.error;
        }
        renderCurrentMode();
      }
      break;
  }
});

document.getElementById('root').addEventListener('click', e => {
  const formBtn = e.target.closest('[data-form]');
  if (formBtn) {
    if (formBtn.disabled) return;
    handleFormAction(formBtn.dataset.form);
    return;
  }
  const btn = e.target.closest('[data-cmd]');
  if (!btn) return;
  if (btn.disabled) return;
  if (btn.dataset.cmd === 'createForm:submit' && formState) {
    formState.submitting = true;
    formState.error = null;
    renderCreateForm();
    const sanitized = sanitizeBranch(formState.branchName);
    vscode.postMessage({
      command: 'createForm:submit',
      branchMode: formState.branchMode,
      branchName: sanitized,
      existingBranch: formState.existingBranch,
      ticketMode: formState.ticketMode,
      ticketId: formState.ticketId,
      ticketTitle: formState.ticketTitle,
      newTicketTitle: formState.newTicketTitle,
      priority: formState.priority,
      team: formState.team,
      carryChanges: formState.carryChanges,
      branchManuallyEdited: formState.branchManuallyEdited,
    });
    return;
  }
  if (btn.dataset.cmd === 'deleteForm:submit' && deleteState) {
    deleteState.submitting = true;
    deleteState.error = null;
    renderDeleteForm();
    vscode.postMessage({
      command: 'deleteForm:submit',
      key: deleteState.key,
      branches: deleteState.branches,
      linear: deleteState.linear,
      pr: deleteState.pr,
    });
    return;
  }
  const msg = { command: btn.dataset.cmd, key: btn.closest('[data-key]')?.dataset.key };
  if (btn.dataset.done !== undefined) msg.isDoneOrClosed = btn.dataset.done === '1';
  vscode.postMessage(msg);
});

const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dis = v => v ? ' disabled' : '';

function sanitizeBranch(v) {
  return v.replace(/[<>:"|?*\\x00-\\x1f\\s~^\\\\]+/g, '-').replace(/\\.{2,}/g, '-').replace(/\\/\\//g, '/').replace(/-+/g, '-').replace(/^[-./]+|[-./]+$/g, '');
}

function slugifyStr(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'untitled';
}

function autoFillBranch() {
  if (formState.branchMode !== 'new' || formState.branchManuallyEdited) return;
  if (formState.ticketMode === 'existing' && formState.ticketId) {
    var name = formInit.branchFormat;
    name = name.replace('\${ticketId}', formState.ticketId).replace('\${slug}', slugifyStr(formState.ticketTitle || ''));
    formState.branchName = sanitizeBranch(name);
  } else if (formState.ticketMode === 'new' && formState.newTicketTitle) {
    formState.branchName = slugifyStr(formState.newTicketTitle);
  } else {
    formState.branchName = '';
  }
}

const icons = {
  house: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z"/></svg>',
  folderOpen: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z"/></svg>',
  diff: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><path d="M200,168V110.63a16,16,0,0,0-4.69-11.32L144,48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="144 96 144 48 192 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><path d="M56,88v57.37a16,16,0,0,0,4.69,11.32L112,208" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="112 160 112 208 64 208" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><circle cx="56" cy="64" r="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><circle cx="200" cy="192" r="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><line x1="200" y1="56" x2="56" y2="200" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="200" y1="200" x2="56" y2="56" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>',
  arrowDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z"/></svg>',
  arrowUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z"/></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>',
  link: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z"/></svg>',
  gitBranch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M232,64a32,32,0,1,0-40,31v17a8,8,0,0,1-8,8H96a23.84,23.84,0,0,0-8,1.38V95a32,32,0,1,0-16,0v66a32,32,0,1,0,16,0V144a8,8,0,0,1,8-8h88a24,24,0,0,0,24-24V95A32.06,32.06,0,0,0,232,64ZM64,64A16,16,0,1,1,80,80,16,16,0,0,1,64,64ZM96,192a16,16,0,1,1-16-16A16,16,0,0,1,96,192ZM200,80a16,16,0,1,1,16-16A16,16,0,0,1,200,80Z"/></svg>',
  linear: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><polyline points="88 136 112 160 168 104" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><rect x="40" y="40" width="176" height="176" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  checkbox: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="40" y="40" width="176" height="176" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="88 136 112 160 168 104" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
};
const ic = name => '<span class="icon">' + icons[name] + '</span>';

function renderCurrentMode() {
  if (mode === 'create' && formState) {
    renderCreateForm();
  } else if (mode === 'delete' && deleteState) {
    renderDeleteForm();
  } else if (latestData) {
    renderList(latestData);
  }
}

function radioOption(name, value, currentValue, title, disabled) {
  return '<label class="radio-option' + (disabled ? ' disabled' : '') + '">' +
    '<input type="radio" name="' + h(name) + '" value="' + h(value) + '"' +
    (currentValue === value ? ' checked' : '') +
    (disabled ? ' disabled' : '') +
    '>' +
    '<span class="radio-body"><div class="radio-title">' + h(title) + '</div></span>' +
  '</label>';
}

function renderList(d) {
  const parts = [mainCard(d)];
  if (!d.groups.length) parts.push('<p class="empty">No trees yet. Click + to create one.</p>');
  for (const g of d.groups) {
    parts.push('<div class="group">' + h(g.label) + ' <span>' + g.trees.length + '</span></div>');
    for (const t of g.trees) parts.push(treeCard(t, d));
  }
  document.getElementById('root').innerHTML = parts.join('');
}

function mainCard(d) {
  const cls = 'card card-main' + (d.mainIsCurrent ? ' current' : '');
  const label = ic('house') + ' ' + h(d.baseBranch) + ' \\u00b7 ' + h(d.repoName);
  if (d.mainIsCurrent) return '<div class="' + cls + '"><span class="card-label">' + label + '</span></div>';
  return '<div class="' + cls + '" data-key="__main__"><a class="card-label" data-cmd="switchToMain">' + label + '</a></div>';
}

function treeCard(t, d) {
  const branchLabel = ic('gitBranch') + ' ' + h(t.branch);
  if (t.cleaning) return '<div class="card" data-key="' + h(t.key) + '"><div class="row"><span class="branch">' + branchLabel + '</span><span class="dim">cleaning up\\u2026</span></div></div>';
  if (!t.isCurrent) return '<div class="card" data-key="' + h(t.key) + '"><div class="row"><a class="branch" data-cmd="switch" title="' + h(t.branch) + '">' + branchLabel + '</a></div></div>';
  const gitDisabled = !!t.busyOperation;
  const busy = t.busyOperation ? '<span class="dim">' + h(t.busyOperation) + '\\u2026</span>' : '';
  const behind = t.behind > 0 ? '<button class="btn" data-cmd="mergeFromMain" title="Merge ' + t.behind + ' commits from main"' + dis(gitDisabled) + '>main \\u2193' + t.behind + '</button>' : '';
  const pushLabel = t.ahead > 0 ? ic('arrowUp') + t.ahead : ic('arrowUp');
  let ticket = '';
  if (d.linearEnabled) {
    if (t.ticketId) {
      const lbl = t.ticketId + (t.ticketTitle ? ': ' + t.ticketTitle : '');
      ticket = '<div class="row">' + ic('checkbox') + '<a class="ticket" data-cmd="openTicket" title="' + h(lbl) + '">' + h(lbl) + '</a><button class="btn faint" data-cmd="detachTicket">detach</button></div>';
    } else {
      ticket = '<div class="row"><button class="btn faint" data-cmd="linkTicket" style="flex:1">' + ic('link') + ' No ticket</button></div>';
    }
  }
  let changes = '';
  if (t.localChanges) {
    const lc = t.localChanges;
    const stats = [lc.added ? '<span class="add">+' + lc.added + '</span>' : '', lc.removed ? '<span class="del">-' + lc.removed + '</span>' : '', lc.modified ? '<span class="mod">~' + lc.modified + '</span>' : ''].filter(Boolean).join(' ');
    changes = '<div class="row"><span class="stats">' + stats + '</span>' +
      '<button class="btn" data-cmd="workingDiff" title="Diff working changes"' + dis(gitDisabled) + '>' + ic('diff') + '</button>' +
      '<button class="btn" data-cmd="branchDiff" title="Diff branch changes"' + dis(gitDisabled) + '>' + ic('diff') + ' branch</button>' +
      '<button class="btn" data-cmd="mainDiff" title="Diff main against branch"' + dis(gitDisabled) + '>' + ic('diff') + ' main</button>' +
      (d.hasAI ? '<button class="btn" data-cmd="commit"' + dis(gitDisabled) + '>commit</button>' : '') +
      '<button class="btn danger" data-cmd="discard" title="Discard changes"' + dis(gitDisabled) + '>' + ic('x') + '</button></div>';
  }
  const isDone = t.prState === 'MERGED' || t.prState === 'CLOSED';
  const doneFlag = isDone ? '1' : '0';
  const lastRow = (isDone || t.prNumber)
    ? '<button class="btn fill" data-cmd="openPR">PR#' + (t.prNumber || '?') + '</button><button class="btn danger" data-cmd="delete" data-done="' + doneFlag + '" title="Delete tree"' + dis(gitDisabled) + '>' + ic('trash') + '</button>'
    : '<button class="btn fill" data-cmd="ship"' + dis(gitDisabled) + '>Ship - Push and Create PR</button><button class="btn danger" data-cmd="delete" data-done="0" title="Delete tree"' + dis(gitDisabled) + '>' + ic('trash') + '</button>';
  return '<div class="card current" data-key="' + h(t.key) + '">' +
    '<div class="row"><span class="branch" title="' + h(t.branch) + '">' + branchLabel + '</span>' + busy + '</div>' +
    '<div class="row">' +
      '<button class="btn" data-cmd="revealInFinder" title="Reveal in Finder">' + ic('folderOpen') + '</button>' +
      '<button class="btn" data-cmd="copyBranch" title="Copy branch name">' + ic('copy') + '</button>' +
      '<button class="btn" data-cmd="pull" title="Pull from remote"' + dis(gitDisabled) + '>' + ic('arrowDown') + '</button>' +
      '<button class="btn" data-cmd="push" title="Push to remote"' + dis(gitDisabled) + '>' + pushLabel + '</button>' +
      behind +
    '</div>' +
    ticket + changes +
    '<div class="row">' + lastRow + '</div>' +
  '</div>';
}

function renderDeleteForm() {
  const ds = deleteState;
  const init = deleteInit;
  const dis = ds.submitting;
  let out = '<div class="form">';

  if (ds.error) {
    out += '<div class="form-error">' + h(ds.error) + '</div>';
  }

  out += '<div class="form-section">';
  out += '<div class="form-title">' + ic('trash') + ' Delete ' + h(init.name) + '</div>';
  out += '<div class="form-copy">Choose what should happen to the worktree, branches, ticket, and pull request.</div>';
  out += '</div>';

  out += '<div class="form-section">';
  out += '<div class="form-title">' + ic('gitBranch') + ' Branches</div>';
  out += '<div class="radio-group">';
  out += radioOption('delete-branches', 'all', ds.branches, 'Delete local + remote', dis);
  out += radioOption('delete-branches', 'local', ds.branches, 'Delete local only', dis);
  out += radioOption('delete-branches', 'keep', ds.branches, 'Keep branches', dis);
  out += '</div></div>';

  if (init.linearEnabled) {
    out += '<div class="form-section">';
    out += '<div class="form-title">' + ic('linear') + ' Linear</div>';
    out += '<div class="radio-group">';
    out += radioOption('delete-linear', 'cancel', ds.linear, 'Move to canceled', dis);
    out += radioOption('delete-linear', 'cleanup', ds.linear, 'Move to done', dis);
    out += radioOption('delete-linear', 'none', ds.linear, 'Do nothing', dis);
    out += '</div></div>';
  }

  if (init.prState === 'OPEN') {
    out += '<div class="form-section">';
    out += '<div class="form-title">Pull Request</div>';
    out += '<div class="radio-group">';
    out += radioOption('delete-pr', 'close', ds.pr, 'Close PR', dis);
    out += radioOption('delete-pr', 'none', ds.pr, 'Do nothing', dis);
    out += '</div></div>';
  } else if (init.prState === 'MERGED' || init.prState === 'CLOSED') {
    out += '<div class="form-section">';
    out += '<div class="form-title">Pull Request</div>';
    out += '<div class="form-copy">PR #' + h(init.prNumber || '?') + ' is already ' + h(init.prState.toLowerCase()) + '.</div>';
    out += '</div>';
  }

  out += '<div class="form-actions">';
  out += '<button class="btn-create" id="deleteSubmitBtn" data-cmd="deleteForm:submit"' + (dis ? ' disabled' : '') + '>' + (dis ? 'Deleting\\u2026' : 'Delete tree') + '</button>';
  out += '<button class="btn-cancel" data-form="cancel"' + (dis ? ' disabled' : '') + '>Cancel</button>';
  out += '</div>';

  out += '</div>';
  document.getElementById('root').innerHTML = out;
  setupDeleteListeners();
}

function renderCreateForm() {
  const fs = formState;
  const init = formInit;
  const dis = fs.submitting;
  let out = '<div class="form">';

  if (fs.error) {
    out += '<div class="form-error">' + h(fs.error) + '</div>';
  }

  // Branch section
  out += '<div class="form-section">';
  out += '<div class="form-row">';
  if (fs.branchMode === 'existing' && fs.existingBranch) {
    out += '<span class="form-value">' + ic('gitBranch') + ' ' + h(fs.existingBranch) + '</span>';
  } else {
    out += '<span class="form-value dim">' + ic('gitBranch') + ' New branch</span>';
  }
  out += '</div>';
  out += '<div class="form-row">';
  out += '<button class="btn" data-cmd="pickBranch"' + (dis ? ' disabled' : '') + '>Select branch</button>';
  if (fs.branchMode === 'existing') {
    out += '<button class="btn" data-form="branchNew"' + (dis ? ' disabled' : '') + '>Create new</button>';
  }
  out += '</div>';
  if (fs.branchMode === 'new') {
    out += '<input class="form-input" id="branchNameInput" placeholder="my-feature-branch" value="' + h(fs.branchName) + '"' + (dis ? ' disabled' : '') + '>';
    out += '<div class="form-hint" id="branchHint" style="display:none"></div>';
    if (fs.ticketMode === 'new' && fs.newTicketTitle && !fs.branchManuallyEdited) {
      out += '<div class="form-hint">Ticket ID will be prepended after creation</div>';
    }
  }
  out += '</div>';

  // Linear section
  if (init.linearEnabled) {
    out += '<div class="form-section">';
    out += '<div class="form-row">';
    if (fs.ticketMode === 'existing' && fs.ticketId) {
      out += '<span class="form-value">' + ic('linear') + ' ' + h(fs.ticketId + ': ' + (fs.ticketTitle || '')) + '</span>';
    } else if (fs.ticketMode === 'new') {
      out += '<span class="form-value dim">' + ic('linear') + ' New Linear ticket</span>';
    } else {
      out += '<span class="form-value dim">' + ic('linear') + ' No Linear ticket</span>';
    }
    out += '</div>';
    out += '<div class="form-row">';
    out += '<button class="btn" data-cmd="pickIssue"' + (dis ? ' disabled' : '') + '>Select ticket</button>';
    out += '<button class="btn' + (fs.ticketMode === 'new' ? ' btn-toggle active' : '') + '" data-form="ticketNew"' + (dis ? ' disabled' : '') + '>Create new</button>';
    out += '<button class="btn' + (fs.ticketMode === 'none' ? ' btn-toggle active' : '') + '" data-form="ticketNone"' + (dis ? ' disabled' : '') + '>No ticket</button>';
    out += '</div>';

    if (fs.ticketMode === 'new') {
      out += '<input class="form-input" id="ticketTitleInput" placeholder="Issue title" value="' + h(fs.newTicketTitle) + '"' + (dis ? ' disabled' : '') + '>';
      out += '<div class="form-row" style="margin-top:6px">';
      out += '<select class="form-select" id="prioritySelect"' + (dis ? ' disabled' : '') + '>';
      out += '<option value="0"' + (fs.priority === 0 ? ' selected' : '') + '>No priority</option>';
      out += '<option value="1"' + (fs.priority === 1 ? ' selected' : '') + '>Urgent</option>';
      out += '<option value="2"' + (fs.priority === 2 ? ' selected' : '') + '>High</option>';
      out += '<option value="3"' + (fs.priority === 3 ? ' selected' : '') + '>Normal</option>';
      out += '<option value="4"' + (fs.priority === 4 ? ' selected' : '') + '>Low</option>';
      out += '</select>';
      if (init.teams.length > 1) {
        out += '<select class="form-select" id="teamSelect"' + (dis ? ' disabled' : '') + '>';
        for (var i = 0; i < init.teams.length; i++) {
          out += '<option value="' + h(init.teams[i]) + '"' + (fs.team === init.teams[i] ? ' selected' : '') + '>' + h(init.teams[i]) + '</option>';
        }
        out += '</select>';
      }
      out += '</div>';
    }
    out += '</div>';
  }

  // Uncommitted changes
  if (init.uncommittedCount > 0) {
    out += '<div class="form-section">';
    out += '<div class="form-row">';
    out += '<span class="form-value dim">' + init.uncommittedCount + ' uncommitted file' + (init.uncommittedCount !== 1 ? 's' : '') + '</span>';
    out += '<button class="btn btn-toggle' + (fs.carryChanges ? ' active' : '') + '" data-form="carryYes"' + (dis ? ' disabled' : '') + '>Carry</button>';
    out += '<button class="btn btn-toggle' + (!fs.carryChanges ? ' active' : '') + '" data-form="carryNo"' + (dis ? ' disabled' : '') + '>Ignore</button>';
    out += '</div>';
    out += '</div>';
  }

  // Action buttons
  var canSubmit = !dis && (
    (fs.branchMode === 'new' ? !!sanitizeBranch(fs.branchName) : !!fs.existingBranch) &&
    (fs.ticketMode !== 'new' || !!fs.newTicketTitle.trim())
  );
  out += '<div class="form-actions">';
  out += '<button class="btn-create" id="submitBtn" data-cmd="createForm:submit"' + (canSubmit ? '' : ' disabled') + '>' + (dis ? 'Creating\\u2026' : 'Create tree') + '</button>';
  out += '<button class="btn-cancel" data-form="cancel"' + (dis ? ' disabled' : '') + '>Cancel</button>';
  out += '</div>';

  out += '</div>';
  document.getElementById('root').innerHTML = out;
  setupFormListeners();
}

function setupDeleteListeners() {
  var branchRadios = document.querySelectorAll('input[name="delete-branches"]');
  branchRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.branches = e.target.value;
    });
  });
  var linearRadios = document.querySelectorAll('input[name="delete-linear"]');
  linearRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.linear = e.target.value;
    });
  });
  var prRadios = document.querySelectorAll('input[name="delete-pr"]');
  prRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.pr = e.target.value;
    });
  });
}

function setupFormListeners() {
  var branchInput = document.getElementById('branchNameInput');
  if (branchInput) {
    branchInput.addEventListener('input', function(e) {
      formState.branchName = e.target.value;
      formState.branchManuallyEdited = e.target.value.length > 0;
      updateFormHints();
    });
    if (formState.ticketMode !== 'new' || formState.newTicketTitle) branchInput.focus();
  }
  var ticketInput = document.getElementById('ticketTitleInput');
  if (ticketInput) {
    ticketInput.addEventListener('input', function(e) {
      formState.newTicketTitle = e.target.value;
      autoFillBranch();
      var bi = document.getElementById('branchNameInput');
      if (bi) bi.value = formState.branchName;
      updateFormHints();
    });
    if (!formState.newTicketTitle) ticketInput.focus();
  }
  var prioritySelect = document.getElementById('prioritySelect');
  if (prioritySelect) {
    prioritySelect.addEventListener('change', function(e) {
      formState.priority = parseInt(e.target.value, 10);
    });
  }
  var teamSelect = document.getElementById('teamSelect');
  if (teamSelect) {
    teamSelect.addEventListener('change', function(e) {
      formState.team = e.target.value;
    });
  }
  updateFormHints();
}

function updateFormHints() {
  var hint = document.getElementById('branchHint');
  if (hint) {
    var sanitized = sanitizeBranch(formState.branchName);
    if (sanitized && sanitized !== formState.branchName) {
      hint.textContent = 'Branch: ' + sanitized;
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
  }
  var submitBtn = document.getElementById('submitBtn');
  if (submitBtn) {
    var canSubmit = !formState.submitting && (
      (formState.branchMode === 'new' ? !!sanitizeBranch(formState.branchName) : !!formState.existingBranch) &&
      (formState.ticketMode !== 'new' || !!formState.newTicketTitle.trim())
    );
    submitBtn.disabled = !canSubmit;
  }
}

function handleFormAction(action) {
  switch (action) {
    case 'branchNew':
      formState.branchMode = 'new';
      formState.existingBranch = null;
      formState.branchManuallyEdited = false;
      autoFillBranch();
      break;
    case 'ticketNew':
      formState.ticketMode = 'new';
      formState.ticketId = null;
      formState.ticketTitle = null;
      autoFillBranch();
      break;
    case 'ticketNone':
      formState.ticketMode = 'none';
      formState.ticketId = null;
      formState.ticketTitle = null;
      autoFillBranch();
      break;
    case 'carryYes':
      formState.carryChanges = true;
      break;
    case 'carryNo':
      formState.carryChanges = false;
      break;
    case 'cancel':
      mode = 'list';
      break;
  }
  renderCurrentMode();
}
</script>
</body>
</html>`;
  }

  dispose(): void { }
}
