import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ForestConfig } from '../config';
import type { ForestContext } from '../context';
import type { StateManager, TreeState } from '../state';
import { getRepoPath } from '../context';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import * as ai from '../cli/ai';
import { shortBaseBranch, slugify } from '../utils/slug';
import { copyConfigFiles, createTree, updateLinear } from '../commands/shared';
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
}

interface WebviewData {
  repoName: string;
  baseBranch: string;
  mainIsCurrent: boolean;
  hasAI: boolean;
  linearEnabled: boolean;
  groups: Array<{ label: string; trees: TreeCardData[] }>;
}

/** Maps a TreeState to the base fields shared by all card states. */
function baseCard(t: TreeState, isCurrent: boolean): TreeCardData {
  return {
    key: `${t.repoPath}:${t.branch}`,
    branch: t.branch, path: t.path,
    ticketId: t.ticketId, ticketTitle: t.title,
    behind: 0, ahead: 0, localChanges: null,
    isCurrent, cleaning: false,
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

  private async handleMessage(msg: Record<string, any>): Promise<void> {
    const { command, key } = msg;

    if (command === 'switchToMain') {
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(getRepoPath()), { forceNewWindow: true });
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

    if (!key) return;
    const colonIdx = key.indexOf(':');
    const repoPath = key.slice(0, colonIdx);
    const branch = key.slice(colonIdx + 1);
    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);

    const withProgress = async (title: string, fn: () => Promise<void>) => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        async () => { try { await fn(); } catch (e: any) { vscode.window.showErrorMessage(`Forest: ${e.message}`); } },
      );
      this.refresh();
    };

    switch (command) {
      case 'pull':
        if (!tree || !tree.path) return;
        await withProgress('Pulling...', () => git.pull(tree.path!));
        break;

      case 'push':
        if (!tree || !tree.path) return;
        await withProgress('Pushing...', () => git.pushBranch(tree.path!, tree.branch));
        break;

      case 'mergeFromMain':
        if (!tree || !tree.path) return;
        await withProgress('Merging from main...', async () => {
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
        if (tree?.path) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(tree.path), { forceNewWindow: true });
        break;

      case 'workingDiff': {
        if (!tree || !tree.path) return;
        const wdiff = await git.workingDiff(tree.path);
        if (!wdiff.trim()) { vscode.window.showInformationMessage('No working changes.'); return; }
        const doc = await vscode.workspace.openTextDocument({ content: wdiff, language: 'diff' });
        vscode.window.showTextDocument(doc, { preview: true });
        break;
      }

      case 'branchDiff': {
        if (!tree || !tree.path) return;
        const bdiff = await git.diffFromBase(tree.path, this.config.baseBranch);
        if (!bdiff.trim()) { vscode.window.showInformationMessage('No changes from base branch.'); return; }
        const doc = await vscode.workspace.openTextDocument({ content: bdiff, language: 'diff' });
        vscode.window.showTextDocument(doc, { preview: true });
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
        await withProgress('Committing...', () => git.commitAll(tree.path!, confirmed));
        break;
      }

      case 'discard': {
        if (!tree || !tree.path) return;
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Discard unstaged', id: 'unstaged' }, { label: 'Discard all (including staged)', id: 'all' }],
          { placeHolder: 'What to discard?' },
        );
        if (!pick) return;
        await withProgress('Discarding...', () =>
          pick.id === 'unstaged' ? git.discardUnstaged(tree.path!) : git.discardChanges(tree.path!),
        );
        break;
      }

      case 'ship':
        vscode.commands.executeCommand('forest.ship', branch);
        break;

      case 'delete':
        vscode.commands.executeCommand('forest.deleteTree', branch, msg.isDoneOrClosed ?? false);
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
          await updateLinear(ctx, ticketId!, revertStatus).catch(() => {});
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
button { cursor: pointer; font-family: var(--vscode-font-family); border: none; border-radius: 3px; }
.btn { background: none; color: var(--vscode-foreground); padding: 1px 5px; font-size: 11px; border: 1px solid var(--vscode-activityBar-border, rgba(128,128,128,0.3)); opacity: 0.75; white-space: nowrap; display: inline-flex; align-items: center; gap: 2px; }
.btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.btn.faint { opacity: 0.45; }
.btn.faint:hover { opacity: 0.8; }
.btn.danger { color: var(--vscode-errorForeground, #f44736) !important; }
.btn-main { flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 8px; font-size: 12px; }
.btn-main:hover { background: var(--vscode-button-hoverBackground); }
.btn-pr { flex: 1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; font-size: 12px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-pr:hover { background: var(--vscode-button-secondaryHoverBackground); }
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
.btn-toggle.active { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); opacity: 1; }
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
    case 'branchPickResult':
      if (msg.branch) {
        formState.branchMode = 'existing';
        formState.existingBranch = msg.branch;
      }
      renderCurrentMode();
      break;
    case 'issuePickResult':
      if (msg.issue) {
        formState.ticketMode = 'existing';
        formState.ticketId = msg.issue.ticketId;
        formState.ticketTitle = msg.issue.title;
        autoFillBranch();
      }
      renderCurrentMode();
      break;
    case 'createResult':
      formState.submitting = false;
      if (msg.success) {
        mode = 'list';
      } else {
        formState.error = msg.error;
      }
      renderCurrentMode();
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
  const msg = { command: btn.dataset.cmd, key: btn.closest('[data-key]')?.dataset.key };
  if (btn.dataset.done !== undefined) msg.isDoneOrClosed = btn.dataset.done === '1';
  vscode.postMessage(msg);
});

const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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
  copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>',
  arrowDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z"/></svg>',
  arrowUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z"/></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>',
  link: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z"/></svg>',
  gitBranch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M232,64a32,32,0,1,0-40,31v17a8,8,0,0,1-8,8H96a23.84,23.84,0,0,0-8,1.38V95a32,32,0,1,0-16,0v66a32,32,0,1,0,16,0V144a8,8,0,0,1,8-8h88a24,24,0,0,0,24-24V95A32.06,32.06,0,0,0,232,64ZM64,64A16,16,0,1,1,80,80,16,16,0,0,1,64,64ZM96,192a16,16,0,1,1-16-16A16,16,0,0,1,96,192ZM200,80a16,16,0,1,1,16-16A16,16,0,0,1,200,80Z"/></svg>',
  linear: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" fill="none"><mask id="lm" fill="white"><path d="M11.2426 11.2426C11.6332 11.6332 12.2731 11.6368 12.6041 11.1946C13.505 9.99105 14 8.52105 14 7C14 5.14349 13.2625 3.36301 11.9497 2.05026C10.637 0.737503 8.85652 4.74079e-06 7 4.53054e-06C5.47896 4.35829e-06 4.00895 0.495053 2.8054 1.39592C2.36326 1.72687 2.36684 2.36684 2.75736 2.75736L7 7L11.2426 11.2426Z"/></mask><path d="M11.2426 11.2426C11.6332 11.6332 12.2731 11.6368 12.6041 11.1946C13.505 9.99105 14 8.52105 14 7C14 5.14349 13.2625 3.36301 11.9497 2.05026C10.637 0.737503 8.85652 4.74079e-06 7 4.53054e-06C5.47896 4.35829e-06 4.00895 0.495053 2.8054 1.39592C2.36326 1.72687 2.36684 2.36684 2.75736 2.75736L7 7L11.2426 11.2426Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" mask="url(#lm)"/><path d="M1.25 3.75L10.25 12.75M0.75 6.25L7.75 13.25M1.25 9.75L4.25 12.75" stroke="currentColor" stroke-linecap="round"/></svg>',
};
const ic = name => '<span class="icon">' + icons[name] + '</span>';

function renderCurrentMode() {
  if (mode === 'create' && formState) {
    renderCreateForm();
  } else if (latestData) {
    renderList(latestData);
  }
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
  const behind = t.behind > 0 ? '<button class="btn" data-cmd="mergeFromMain" title="Merge ' + t.behind + ' commits from main">main \\u2193' + t.behind + '</button>' : '';
  const pushLabel = t.ahead > 0 ? ic('arrowUp') + t.ahead : ic('arrowUp');
  let ticket = '';
  if (d.linearEnabled) {
    if (t.ticketId) {
      const lbl = t.ticketId + (t.ticketTitle ? ': ' + t.ticketTitle : '');
      ticket = '<div class="row"><a class="ticket" data-cmd="openTicket" title="' + h(lbl) + '">' + h(lbl) + '</a><button class="btn faint" data-cmd="detachTicket">detach</button></div>';
    } else {
      ticket = '<div class="row"><button class="btn faint" data-cmd="linkTicket" style="flex:1">' + ic('link') + ' No ticket</button></div>';
    }
  }
  let changes = '';
  if (t.localChanges) {
    const lc = t.localChanges;
    const stats = [lc.added ? '<span class="add">+' + lc.added + '</span>' : '', lc.removed ? '<span class="del">-' + lc.removed + '</span>' : '', lc.modified ? '<span class="mod">~' + lc.modified + '</span>' : ''].filter(Boolean).join(' ');
    changes = '<div class="row"><span class="stats">' + stats + '</span>' +
      '<button class="btn" data-cmd="workingDiff">diff</button>' +
      '<button class="btn" data-cmd="branchDiff">branch diff</button>' +
      (d.hasAI ? '<button class="btn" data-cmd="commit">commit</button>' : '') +
      '<button class="btn danger" data-cmd="discard">discard</button></div>';
  }
  const isDone = t.prState === 'MERGED' || t.prState === 'CLOSED';
  const doneFlag = isDone ? '1' : '0';
  const lastRow = (isDone || t.prNumber)
    ? '<button class="btn-pr" data-cmd="openPR">PR#' + (t.prNumber || '?') + '</button><button class="btn danger" data-cmd="delete" data-done="' + doneFlag + '" title="Delete tree">' + ic('trash') + '</button>'
    : '<button class="btn-main" data-cmd="ship">Ship</button><button class="btn danger" data-cmd="delete" data-done="0" title="Delete tree">' + ic('trash') + '</button>';
  return '<div class="card current" data-key="' + h(t.key) + '">' +
    '<div class="row"><span class="branch" title="' + h(t.branch) + '">' + branchLabel + '</span></div>' +
    '<div class="row">' +
      '<button class="btn" data-cmd="revealInFinder" title="Reveal in Finder">' + ic('folderOpen') + '</button>' +
      '<button class="btn" data-cmd="copyBranch" title="Copy branch name">' + ic('copy') + '</button>' +
      '<button class="btn" data-cmd="pull" title="Pull from remote">' + ic('arrowDown') + '</button>' +
      '<button class="btn" data-cmd="push" title="Push to remote">' + pushLabel + '</button>' +
      behind +
    '</div>' +
    ticket + changes +
    '<div class="row">' + lastRow + '</div>' +
  '</div>';
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
