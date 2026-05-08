import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ForestConfig } from '../config';
import type { ForestContext } from '../context';
import { getHostWorkspacePath } from '../context';
import { displayName, type StateManager, type TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import * as ai from '../cli/ai';
import { formatBranch } from '../utils/slug';
import { copyConfigFiles, createTree, ensureTreeIdle, focusOrOpenWindow, getBlockingTreeOperation, openTreeWindow, updateLinear, withTreeOperation } from '../commands/shared';
import { executeDeletePlan, type DeletePlan } from '../commands/cleanup';
import { shipCore } from '../commands/ship';
import { notify } from '../notify';
import { pickIssue } from '../commands/create';
import { linkTicket } from '../commands/linkTicket';

interface TreeCardData {
  key: string;
  branch: string;
  ticketId?: string;
  ticketTitle?: string;
  prNumber?: number;
  prState?: string;
  behind: number;
  ahead: number;
  remoteBehind: number;
  localChanges: { added: number; removed: number; modified: number } | null;
  isCurrent: boolean;
  cleaning: boolean;
  busyOperation?: string;
}

interface WebviewData {
  repoName: string;
  baseBranch: string;
  mainIsCurrent: boolean;
  mainBehind: number;
  hasAI: boolean;
  hasAutomerge: boolean;
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
    branch: t.branch,
    ticketId: t.ticketId, ticketTitle: t.title,
    behind: 0, ahead: 0, remoteBehind: 0, localChanges: null,
    isCurrent, cleaning: false, busyOperation: t.busyOperation,
  };
}

export class ForestWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ctx?: ForestContext;
  private dataCache = new Map<string, { data: Promise<TreeCardData>; time: number }>();
  private readonly CACHE_TTL = 30_000;
  private pendingAbort: AbortController | null = null;

  constructor(
    private readonly stateManager: StateManager,
    private readonly config: ForestConfig,
    private readonly extensionUri: vscode.Uri,
  ) { }

  private log(msg: string): void {
    this.ctx?.outputChannel.appendLine(`[Forest] ${msg}`);
  }

  setContext(ctx: ForestContext): void { this.ctx = ctx; }

  private get repoPath(): string { return this.ctx!.repoPath; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')],
    };
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
    const repoPath = this.repoPath;
    const localChanges = await git.localChanges(repoPath).catch(() => null);
    const uncommittedCount = localChanges ? localChanges.added + localChanges.removed + localChanges.modified : 0;
    const hasDevcontainer = fs.existsSync(path.join(repoPath, '.devcontainer', 'devcontainer.json'));
    this.postMessage({
      type: 'showCreateForm',
      init: {
        linearEnabled: this.config.linear.enabled && linear.isAvailable(),
        teams: this.config.linear.teams ?? [],
        uncommittedCount,
        branchFormat: this.config.branchFormat,
        branchPrefix: this.config.branchPrefix ?? '',
        hasDevcontainer,
      },
    });
  }

  async showDeleteForm(branchArg?: string): Promise<boolean> {
    if (!this.view?.visible || !this.ctx) return false;
    const repoPath = this.repoPath;
    const branch = branchArg ?? this.ctx.currentTree?.branch;
    if (!branch) return false;

    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);
    if (!tree?.path) return false;
    const active = await getBlockingTreeOperation(this.ctx, tree);
    if (active) {
      notify.info(`${displayName(tree)} is already ${active}.`);
      return true;
    }

    const [pr, hasRemote] = await Promise.all([
      this.config.github.enabled ? gh.prStatus(tree.path).catch(() => null) : null,
      git.remoteBranchExists(repoPath, tree.branch).catch(() => false),
    ]);
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
        defaultBranches: hasRemote ? 'all' : 'local',
        remoteDeleted: !hasRemote,
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

  /** Run an async operation with inline pending state in the webview. */
  private async runPending(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const ac = new AbortController();
    this.pendingAbort = ac;
    try {
      await fn(ac.signal);
    } catch (e: any) {
      if (!ac.signal.aborted) notify.error(`Forest: ${e.message}`);
    } finally {
      this.pendingAbort = null;
      this.postMessage({ type: 'pendingDone' });
      this.refresh();
    }
  }

  private async update(): Promise<void> {
    if (!this.ctx) return;
    try {
      const data = await this.buildData();
      if (this.view?.visible) {
        this.view.webview.postMessage({ type: 'update', data });
      }
    } catch (e: any) {
      this.log(`Webview update failed: ${e.stack ?? e.message}`);
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

    const [behind, ahead, remoteBehind, pr, localChanges] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, tree.branch),
      git.commitsBehindRemote(tree.path, tree.branch),
      this.config.github.enabled ? gh.prStatus(tree.path) : Promise.resolve(null),
      git.localChanges(tree.path),
    ]);

    if (pr?.url && !tree.prUrl) {
      this.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: pr.url }).catch(() => { });
    }

    return { ...base, prNumber: pr?.number, prState: pr?.state, behind, ahead, remoteBehind, localChanges };
  }

  private async buildData(): Promise<WebviewData> {
    const repoPath = this.repoPath;
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const curPath = getHostWorkspacePath();

    const liveKeys = new Set(trees.map(t => `${t.repoPath}:${t.branch}`));
    for (const k of this.dataCache.keys()) {
      if (!liveKeys.has(k)) this.dataCache.delete(k);
    }

    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const mainIsCurrent = curPath === repoPath;
    const [cardResults, mainBehind] = await Promise.all([
      Promise.all(trees.map(t => t.cleaning ? Promise.resolve(null) : this.getTreeData(t).catch(() => null))),
      mainIsCurrent ? git.commitsBehind(repoPath, this.config.baseBranch) : Promise.resolve(0),
    ]);

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
      const cached = cardResults[i];
      if (!cached) return;
      const card: TreeCardData = { ...cached, isCurrent, busyOperation: t.busyOperation };
      const s = card.prState;
      if (s === 'MERGED') done.push(card);
      else if (s === 'CLOSED') closed.push(card);
      else if (card.prNumber) inReview.push(card);
      else inProgress.push(card);
    });

    const groups: WebviewData['groups'] = [];
    if (inProgress.length) groups.push({ label: 'In progress', trees: inProgress });
    if (inReview.length) groups.push({ label: 'In review', trees: inReview });
    if (done.length) groups.push({ label: 'Done', trees: done });
    if (closed.length) groups.push({ label: 'Closed', trees: closed });
    if (cleaning.length) groups.push({ label: 'Deleting', trees: cleaning });

    return {
      repoName: path.basename(repoPath),
      baseBranch: this.config.baseBranch,
      mainIsCurrent,
      mainBehind,
      hasAI: !!this.config.ai,
      hasAutomerge: this.config.github.enabled && (gh.repoHasAutomergeCached(repoPath) ?? false),
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
      emptyMessage: `No branch changes from ${this.config.baseBranch}.`,
      sourcePath: `${tree.path}/${mergeBase}...HEAD`,
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
      notify.info(opts.emptyMessage);
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
    } catch (e: any) {
      this.log(`Multi-diff editor unavailable (${e.message}); falling back to SCM view`);
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  private async handleMessage(msg: Record<string, any>): Promise<void> {
    const { command, key } = msg;

    if (command === 'switchToMain') {
      focusOrOpenWindow(vscode.Uri.file(this.repoPath));
      return;
    }

    if (key === '__main__') {
      const repoPath = this.repoPath;
      switch (command) {
        case 'revealInFinder':
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repoPath));
          break;
        case 'pull':
          await this.runPending((signal) => git.pull(repoPath, this.config.baseBranch, { signal }));
          break;
        case 'push':
          await this.runPending((signal) => git.pushBranch(repoPath, this.config.baseBranch, { signal }));
          break;
      }
      return;
    }

    if (command === 'cancelPending') {
      this.pendingAbort?.abort();
      return;
    }

    // Create form commands (no key needed)
    if (command === 'pickBranch') {
      await this.runPending(async (signal) => {
        const branches = await git.listBranches(this.repoPath, this.config.baseBranch, { signal });
        if (!branches.length) {
          notify.info('No available branches.');
          this.postMessage({ type: 'branchPickResult', branch: null });
          return;
        }
        const picked = await vscode.window.showQuickPick(
          branches.map(b => ({ label: b })),
          { placeHolder: 'Select a branch' },
        );
        this.postMessage({ type: 'branchPickResult', branch: picked?.label ?? null });
      });
      return;
    }

    if (command === 'pickIssue') {
      if (!this.ctx) return;
      await this.runPending(async (signal) => {
        const result = await pickIssue(this.ctx!, { signal });
        this.postMessage({ type: 'issuePickResult', issue: result ?? null });
      });
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

    /** Run a tree-level git operation with inline pending state. */
    const runTreeAction = (busyOperation: string, fn: (signal: AbortSignal) => Promise<void>) =>
      this.runPending(async (signal) => {
        await withTreeOperation(
          ctx!,
          tree as TreeState & { path: string },
          busyOperation,
          () => fn(signal),
        );
      });

    /** Send pendingDone if the command had a pending label but won't reach runPending. */
    const bail = () => { this.postMessage({ type: 'pendingDone' }); };

    switch (command) {
      case 'pull':
        if (!tree?.path) { bail(); return; }
        await runTreeAction('pulling', (signal) => git.pull(tree.path!, tree.branch, { signal }));
        break;

      case 'push':
        if (!tree?.path) { bail(); return; }
        await runTreeAction('pushing', (signal) => git.pushBranch(tree.path!, tree.branch, { signal }));
        break;

      case 'mergeFromMain':
        if (!tree?.path) { bail(); return; }
        await runTreeAction('merging', async (signal) => {
          await git.pullMerge(tree.path!, this.config.baseBranch, { signal });
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
        if (!tree?.ticketId) { bail(); return; }
        await this.runPending(async (signal) => {
          const issue = await linear.getIssue(tree.ticketId!, { signal }).catch(() => null);
          if (issue?.url) vscode.env.openExternal(vscode.Uri.parse(issue.url));
        });
        break;
      }

      case 'copyTicketDescription': {
        if (!tree?.ticketId) { bail(); return; }
        await this.runPending(async (signal) => {
          try {
            const desc = await linear.getIssueDescription(tree.ticketId!, { signal });
            await vscode.env.clipboard.writeText(desc);
            notify.info(desc ? 'Ticket description copied.' : 'Ticket has no description.');
          } catch (e: any) {
            if (signal.aborted) return;
            notify.warn(`Could not fetch ticket description: ${e.message}`);
          }
        });
        break;
      }

      case 'detachTicket':
        if (!tree) return;
        await this.stateManager.updateTree(repoPath, branch, { ticketId: undefined, title: undefined });
        this.refresh();
        break;

      case 'linkTicket':
      case 'newTicket': {
        const mode = command === 'newTicket' ? 'create' : 'select';
        await linkTicket(ctx!, branch, mode);
        this.refresh();
        break;
      }

      case 'switch':
        if (tree?.path) openTreeWindow(tree);
        break;

      case 'workingDiff': {
        if (!tree || !tree.path) { bail(); return; }
        await this.runPending(async () => {
          const hasChanges = await git.hasUncommittedChanges(tree.path!);
          if (!hasChanges) { notify.info('No working changes.'); return; }
          await vscode.commands.executeCommand('git.viewChanges', vscode.Uri.file(tree.path!));
        });
        break;
      }

      case 'branchDiff': {
        if (!tree || !tree.path) { bail(); return; }
        await this.runPending(async () => { await this.openBaseDiff(tree); });
        break;
      }

      case 'commit': {
        if (!tree || !tree.path || !this.config.ai) { bail(); return; }
        await this.runPending(async (signal) => {
          const commitDiff = await git.workingDiff(tree.path!);
          if (!commitDiff.trim()) { notify.info('No working changes to commit.'); return; }
          const message = await ai.generateCommitMessage(commitDiff, { signal });
          const confirmed = await vscode.window.showInputBox({
            value: message,
            prompt: 'Commit message — all changes will be staged',
            ignoreFocusOut: true,
          });
          if (!confirmed) return;
          await withTreeOperation(
            ctx!,
            tree as TreeState & { path: string },
            'committing',
            () => git.commitAll(tree.path!, confirmed, { signal }),
          );
        });
        break;
      }

      case 'discard': {
        if (!tree || !tree.path) { bail(); return; }
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Discard unstaged', id: 'unstaged' }, { label: 'Discard all (including staged)', id: 'all' }],
          { placeHolder: 'What to discard?' },
        );
        if (!pick) { bail(); return; }
        await runTreeAction('discarding', (signal) =>
          pick.id === 'unstaged' ? git.discardUnstaged(tree.path!, { signal }) : git.discardChanges(tree.path!, { signal }),
        );
        break;
      }

      case 'ship':
      case 'shipMerge': {
        if (!tree?.path || !ctx) { bail(); return; }
        if (await git.hasUncommittedChanges(tree.path)) {
          const choice = await vscode.window.showWarningMessage(
            'You have uncommitted changes.', 'Ship Anyway', 'Cancel',
          );
          if (choice !== 'Ship Anyway') { bail(); return; }
        }
        const automerge = command === 'shipMerge';
        await this.runPending(async (signal) => {
          const prUrl = await withTreeOperation(
            ctx,
            tree as TreeState & { path: string },
            'shipping',
            () => shipCore(ctx, tree as TreeState & { path: string }, automerge, signal),
          );
          if (prUrl) {
            notify.info(`Shipped! PR: ${prUrl}`);
            vscode.env.openExternal(vscode.Uri.parse(prUrl));
          } else if (prUrl !== undefined) {
            notify.info('Shipped!');
          }
        });
        break;
      }

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
    const repoPath = this.repoPath;

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
        branch = (ctx.config.branchPrefix ?? '') + formatBranch(ctx.config.branchFormat, ticketId, title);
      } else {
        // msg.branchName is the typed suffix; webview shows the prefix as a static label
        branch = (ctx.config.branchPrefix ?? '') + msg.branchName;
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
          repoPath: ctx.repoPath,
          ticketId,
          title,
          existingBranch: msg.branchMode === 'existing',
          carryChanges,
          useDevcontainer: !!msg.useDevcontainer,
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
      notify.error('Delete failed: tree path is missing.');
      this.postMessage({ type: 'deleteResult', key, success: false, error: 'Tree path is missing.' });
      return;
    }
    if (!await ensureTreeIdle(ctx, tree)) {
      const error = `${displayName(tree)} is busy with another Git operation.`;
      notify.error(error);
      this.postMessage({ type: 'deleteResult', key, success: false, error });
      return;
    }

    try {
      const plan: DeletePlan = {
        branches: msg.branches,
        linear: msg.linear,
        pr: msg.pr,
      };
      const success = await executeDeletePlan(ctx, tree as TreeState & { path: string }, plan);
      if (!success) {
        notify.error('Delete was interrupted. Check notifications for details.');
      }
      this.postMessage({
        type: 'deleteResult',
        key,
        success,
        error: success ? null : 'Delete was interrupted. Check notifications for details.',
      });
    } catch (e: any) {
      notify.error(`Delete failed: ${e.message}`);
      this.postMessage({ type: 'deleteResult', key, success: false, error: e.message });
    }
  }

  private getHtml(): string {
    if (!this.view) return '';
    const nonce = crypto.randomBytes(16).toString('base64');
    const webview = this.view.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'webview.css'),
    );
    const iconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'icons.js'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'webview.js'),
    );
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="root"><div style="display:flex;flex-direction:column;align-items:center;padding:32px;color:var(--vscode-descriptionForeground)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity:0.5;margin-bottom:8px"><path d="M7.25 23V15C7.25 14.5858 7.58579 14.25 8 14.25C8.41421 14.25 8.75 14.5858 8.75 15V23C8.75 23.4142 8.41421 23.75 8 23.75C7.58579 23.75 7.25 23.4142 7.25 23Z" fill="currentColor"/><path d="M18.25 23V21C18.25 20.5858 18.5858 20.25 19 20.25C19.4142 20.25 19.75 20.5858 19.75 21V23C19.75 23.4142 19.4142 23.75 19 23.75C18.5858 23.75 18.25 23.4142 18.25 23Z" fill="currentColor"/><path d="M13.25 13.5C13.25 10.5651 11.8468 7.7172 10.3789 5.55371C9.65147 4.48158 8.92305 3.59966 8.37695 2.98633C8.23812 2.8304 8.11174 2.69163 8 2.57227C7.88826 2.69163 7.76188 2.8304 7.62305 2.98633C7.07695 3.59966 6.34853 4.48158 5.62109 5.55371C4.15318 7.7172 2.75 10.5651 2.75 13.5C2.75 16.3995 5.1005 18.75 8 18.75C10.8995 18.75 13.25 16.3995 13.25 13.5ZM14.75 13.5C14.75 17.2279 11.7279 20.25 8 20.25C4.27208 20.25 1.25 17.2279 1.25 13.5C1.25 10.1212 2.84682 6.96902 4.37891 4.71094C5.15138 3.57242 5.92308 2.63842 6.50195 1.98828C6.79174 1.66283 7.03472 1.40768 7.20605 1.23242C7.29172 1.1448 7.3599 1.07678 7.40723 1.03028C7.43077 1.00714 7.44898 0.989043 7.46191 0.976565C7.46841 0.970302 7.47385 0.965439 7.47754 0.961916L7.4834 0.956057H7.48438C7.77367 0.681884 8.22633 0.681884 8.51562 0.956057L8 1.5L8.5166 0.956057L8.52246 0.961916C8.52615 0.965439 8.53159 0.970302 8.53809 0.976565C8.55102 0.989043 8.56923 1.00714 8.59277 1.03028C8.6401 1.07678 8.70828 1.1448 8.79395 1.23242C8.96528 1.40768 9.20826 1.66283 9.49805 1.98828C10.0769 2.63842 10.8486 3.57242 11.6211 4.71094C13.1532 6.96902 14.75 10.1212 14.75 13.5Z" fill="currentColor"/><path d="M21.25 18C21.25 16.6435 20.5968 15.2954 19.8789 14.2373C19.5659 13.776 19.2518 13.3873 19 13.0977C18.7482 13.3873 18.4341 13.776 18.1211 14.2373C17.4032 15.2954 16.75 16.6435 16.75 18C16.75 19.2427 17.7573 20.25 19 20.25C20.2427 20.25 21.25 19.2427 21.25 18ZM22.75 18C22.75 20.0711 21.0711 21.75 19 21.75C16.9289 21.75 15.25 20.0711 15.25 18C15.25 16.1998 16.0969 14.5482 16.8789 13.3955C17.2763 12.8098 17.6731 12.3294 17.9707 11.9951C18.1198 11.8277 18.2457 11.6958 18.335 11.6045C18.3795 11.5589 18.4151 11.523 18.4404 11.498C18.453 11.4857 18.4634 11.4758 18.4707 11.4687L18.4834 11.4561H18.4844C18.7737 11.1819 19.2263 11.1819 19.5156 11.4561L19 12L19.5166 11.4561L19.5293 11.4687C19.5366 11.4758 19.547 11.4857 19.5596 11.498C19.5849 11.523 19.6205 11.5589 19.665 11.6045C19.7543 11.6958 19.8802 11.8277 20.0293 11.9951C20.3269 12.3294 20.7237 12.8098 21.1211 13.3955C21.9031 14.5482 22.75 16.1998 22.75 18Z" fill="currentColor"/></svg><span style="font-size:11px">Loading…</span></div></div>
<script nonce="${nonce}" src="${iconsUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = null;
    this.dataCache.clear();
    this.view = undefined;
  }
}
