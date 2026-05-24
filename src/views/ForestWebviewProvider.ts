import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ForestConfig } from '../config';
import type { ForestContext } from '../context';
import { displayName, type StateManager, type TreeState } from '../state';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import * as linear from '../cli/linear';
import * as ai from '../cli/ai';
import { formatBranch, sanitizeBranch } from '../utils/slug';
import { copyConfigFiles, createTree, ensureTreeIdle, focusOrOpenWindow, getBlockingTreeOperation, openTreeWindow, updateLinear, withTreeOperation } from '../commands/shared';
import { executeDeletePlan, type DeletePlan } from '../commands/cleanup';
import { shipCore } from '../commands/ship';
import { notify } from '../notify';
import { pickIssue } from '../commands/create';
import { linkTicket } from '../commands/linkTicket';
import { parseTreeKey, TreeDataService, treeKey } from './treeData';

function gitRefUri(filePath: string, ref: string): vscode.Uri {
  const fileUri = vscode.Uri.file(filePath);
  return fileUri.with({
    scheme: 'git',
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}

export class ForestWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ctx?: ForestContext;
  private pendingAbort: AbortController | null = null;
  private readonly data: TreeDataService;

  constructor(
    private readonly stateManager: StateManager,
    private readonly config: ForestConfig,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.data = new TreeDataService(
      stateManager,
      config,
      () => this.repoPath,
      (msg) => this.log(msg),
    );
  }

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
    this.data.clear();
    this.update();
  }

  refreshTrees(): void { this.refresh(); }

  private async getCreateFormInit() {
    if (!this.view?.visible || !this.ctx) return null;
    const repoPath = this.repoPath;
    const localChanges = await git.localChanges(repoPath).catch(() => null);
    const uncommittedCount = localChanges ? localChanges.added + localChanges.removed + localChanges.modified : 0;
    const hasDevcontainer = fs.existsSync(path.join(repoPath, '.devcontainer', 'devcontainer.json'));
    return {
      linearEnabled: this.config.linear.enabled && linear.isAvailable(),
      teams: this.config.linear.teams ?? [],
      uncommittedCount,
      hasDevcontainer,
    };
  }

  async showCreateForm(): Promise<boolean> {
    const init = await this.getCreateFormInit();
    if (!init) return false;
    this.postMessage({ type: 'showCreateForm', init });
    return true;
  }

  async showCreateFormWithIssue(issue: { id: string; title: string }): Promise<boolean> {
    const init = await this.getCreateFormInit();
    if (!init) return false;
    this.postMessage({
      type: 'showCreateForm',
      init,
      preselectedIssue: {
        ticketId: issue.id,
        title: issue.title,
        branchName: formatBranch(this.config.branchFormat, issue.id, issue.title),
      },
    });
    return true;
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
        key: treeKey(tree),
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
      const data = await this.data.build();
      if (this.view?.visible) {
        this.view.webview.postMessage({ type: 'update', data });
      }
    } catch (e: any) {
      this.log(`Webview update failed: ${e.stack ?? e.message}`);
    }
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
        const issue = await pickIssue(this.ctx!, { signal });
        this.postMessage({ type: 'issuePickResult', issue: issue ? { ...issue, branchName: formatBranch(this.config.branchFormat, issue.ticketId, issue.title) } : null });
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
    const parsed = parseTreeKey(key);
    if (!parsed) return;
    const { repoPath, branch } = parsed;
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
          try {
            await git.pullMerge(tree.path!, this.config.baseBranch, { signal });
          } catch (e: any) {
            const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
            if (/CONFLICT|Automatic merge failed/i.test(output)) {
              throw new Error('Merge stopped with conflicts. Resolve them in this worktree.');
            }
            throw e;
          }
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
        branch = sanitizeBranch(formatBranch(ctx.config.branchFormat, ticketId, title));
      } else {
        branch = sanitizeBranch(String(msg.branchName ?? ''));
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
          outputChannel: ctx.outputChannel,
        });
      } catch (e: any) {
        // Revert Linear issue status if we just created it
        if (newlyCreatedTicket) {
          const revertStatus = ctx.config.linear.statuses.issueList[ctx.config.linear.statuses.issueList.length - 1];
          await updateLinear(ctx, ticketId!, revertStatus).catch((e) => this.log(`Linear revert failed: ${e.message}`));
        }
        throw e;
      }

      if (ticketId) {
        await updateLinear(ctx, ticketId, ctx.config.linear.statuses.onNew);
      }
      ctx.todosProvider?.refresh();

      this.postMessage({ type: 'createResult', success: true });
    } catch (e: any) {
      this.postMessage({ type: 'createResult', success: false, error: e.message });
    }
  }

  private async handleDeleteSubmit(msg: Record<string, any>): Promise<void> {
    if (!this.ctx || !msg.key) return;
    const ctx = this.ctx;
    const key = String(msg.key);
    const parsed = parseTreeKey(key);
    if (!parsed) return;
    const { repoPath, branch } = parsed;
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
    return fs.readFileSync(vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'webview.html').fsPath, 'utf8')
      .replaceAll('{{nonce}}', nonce)
      .replace('{{cspSource}}', webview.cspSource)
      .replace('{{cssUri}}', String(cssUri))
      .replace('{{iconsUri}}', String(iconsUri))
      .replace('{{jsUri}}', String(jsUri));
  }

  dispose(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = null;
    this.data.clear();
    this.view = undefined;
  }
}
