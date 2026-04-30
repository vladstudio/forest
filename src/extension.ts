import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, getTreesDir } from './config';
import { ShortcutItem, ShortcutsTreeProvider } from './views/ShortcutsTreeProvider';
import { StateManager } from './state';
import { ForestContext, getHostWorkspacePath, getRepoPath } from './context';
import { ShortcutManager } from './managers/ShortcutManager';
import { StatusBarManager } from './managers/StatusBarManager';
import { ForestWebviewProvider } from './views/ForestWebviewProvider';
import { start } from './commands/create';
import { linkTicket } from './commands/linkTicket';
import { switchTree } from './commands/switch';
import { ship } from './commands/ship';
import { cleanupMerged, deleteTree } from './commands/cleanup';
import { update, rebase, pull, push } from './commands/update';
import { list } from './commands/list';
import { deleteWorkspaceFiles, focusOrOpenWindow } from './commands/shared';
import * as gh from './cli/gh';
import * as linear from './cli/linear';
import { notify } from './notify';

const emptyProvider: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('no items'); },
  getChildren: () => [],
};

export async function activate(context: vscode.ExtensionContext) {
  const config = await loadConfig();
  if (!config) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('forest.setup', emptyProvider),
      vscode.commands.registerCommand('forest.copySetupPrompt', () => {
        vscode.env.clipboard.writeText('Set up Forest (https://github.com/vladstudio/forest) for this project. Create .forest/config.json with the required configuration.');
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Copied to clipboard' },
          () => new Promise(resolve => setTimeout(resolve, 3000)),
        );
      }),
    );
    return;
  }

  vscode.commands.executeCommand('setContext', 'forest.active', true);
  // When GitHub integration is disabled, keep the full UI active without requiring gh.
  const ghReady = !config.github.enabled || await gh.isAvailable();
  vscode.commands.executeCommand('setContext', 'forest.ghAvailable', ghReady);
  if (!ghReady) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('forest.ghMissing', emptyProvider),
    );
    return;
  }
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.linear.enabled);
  vscode.commands.executeCommand('setContext', 'forest.multipleBrowsers', config.browser.length > 1);
  vscode.commands.executeCommand('setContext', 'forest.multipleTerminals', config.terminal.length > 1);
  linear.configure(config.linear.apiKey);

  const repoPath = getRepoPath();

  // Validate Linear config statuses against actual workflow states
  if (config.linear.enabled && config.linear.teams?.length) {
    linear.validateStatuses(config.linear.statuses, config.linear.teams).then(problems => {
      if (!problems.length) return;
      vscode.window.showWarningMessage(
        `Forest config: ${problems.join('. ')}`,
        'Open Config',
      ).then(action => {
        if (action === 'Open Config') {
          vscode.workspace.openTextDocument(path.join(repoPath, '.forest', 'config.json'))
            .then(doc => vscode.window.showTextDocument(doc));
        }
      });
    }).catch(() => { });
  }

  // Watch config files for external edits
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.join(repoPath, '.forest'), '{config,local}.json'),
  );
  let configDebounce: ReturnType<typeof setTimeout> | undefined;
  let configNotificationVisible = false;
  const onConfigChange = () => {
    clearTimeout(configDebounce);
    configDebounce = setTimeout(() => {
      if (configNotificationVisible) return;
      configNotificationVisible = true;
      vscode.window.showInformationMessage(
        'Forest config changed. Reload to apply?',
        'Reload Window',
      ).then(action => {
        configNotificationVisible = false;
        if (action === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }, 500);
  };
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);
  configWatcher.onDidDelete(onConfigChange);
  context.subscriptions.push(configWatcher, { dispose: () => clearTimeout(configDebounce) });

  const stateManager = new StateManager();
  await stateManager.initialize();

  const outputChannel = vscode.window.createOutputChannel('Forest');

  // On startup, clear stale cleaning flags from crashed teardowns.
  // cleaning:true + path exists  → teardown never ran; clear the flag so the user can retry.
  // cleaning:true + path missing → handled by pruneOrphans below (orphan removal).
  {
    await stateManager.clearStaleTreeOperations(repoPath);
    const s = await stateManager.load();
    for (const tree of stateManager.getTreesForRepo(s, repoPath)) {
      if (tree.cleaning && tree.path && fs.existsSync(tree.path)) {
        await stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
      }
    }
  }

  /** Prune trees whose worktree folders no longer exist on disk. Returns latest state. */
  const pruneOrphans = async (): Promise<import('./state').ForestState> => {
    // Clean up stale .removing directories from interrupted deletions
    const treesDir = getTreesDir(repoPath);
    if (fs.existsSync(treesDir)) {
      for (const entry of fs.readdirSync(treesDir)) {
        if (entry.includes('.removing.')) {
          await fs.promises.rm(path.join(treesDir, entry), { recursive: true, force: true }).catch(() => { });
        }
      }
    }
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, repoPath);
    for (const tree of trees) {
      if (tree.path && !fs.existsSync(tree.path)) {
        outputChannel.appendLine(`[Forest] Pruning orphan: ${tree.branch} (${tree.path} missing)`);
        await stateManager.removeTree(tree.repoPath, tree.branch);
        deleteWorkspaceFiles(tree);
      }
    }
    return stateManager.load();
  };

  /** Recover worktrees that exist on disk but are missing from state. */
  const recoverOrphanWorktrees = async (state: import('./state').ForestState): Promise<import('./state').ForestState> => {
    const treesDir = getTreesDir(repoPath);
    if (!fs.existsSync(treesDir)) return state;
    const knownPaths = new Set(
      stateManager.getTreesForRepo(state, repoPath).map(t => t.path).filter(Boolean),
    );
    for (const entry of fs.readdirSync(treesDir)) {
      if (entry.startsWith('.')) continue;
      const dirPath = path.join(treesDir, entry);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (knownPaths.has(dirPath)) continue;
      // Check if it's a valid git worktree
      const gitFile = path.join(dirPath, '.git');
      if (!fs.existsSync(gitFile)) continue;
      try {
        // Read branch from git worktree HEAD
        const gitContent = fs.readFileSync(gitFile, 'utf8').trim();
        const gitdir = path.resolve(dirPath, gitContent.replace('gitdir: ', ''));
        const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
        const branch = head.startsWith('ref: refs/heads/') ? head.replace('ref: refs/heads/', '') : '';
        if (!branch) continue;
        outputChannel.appendLine(`[Forest] Recovered orphan worktree: ${branch} at ${dirPath}`);
        await stateManager.addTree(repoPath, {
          branch, repoPath, path: dirPath,
          createdAt: new Date(fs.statSync(dirPath).birthtimeMs).toISOString(),
        });
      } catch { /* not a valid worktree, skip */ }
    }
    return stateManager.load();
  };

  const postPruneState = await recoverOrphanWorktrees(await pruneOrphans());

  // Detect if current workspace is a tree (reuse state after pruning).
  // getHostWorkspacePath maps remote (dev container) workspace URIs back to the host tree path.
  const curPath = getHostWorkspacePath();
  const currentTree = curPath ? Object.values(postPruneState.trees).find(t => t.path === curPath) : undefined;
  vscode.commands.executeCommand('setContext', 'forest.isTree', !!currentTree);

  const shortcutManager = new ShortcutManager(config);
  const statusBarManager = new StatusBarManager(currentTree);
  const forestProvider = new ForestWebviewProvider(stateManager, config, context.extensionUri);
  const shortcutsProvider = new ShortcutsTreeProvider(config);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('forest.trees', forestProvider),
    vscode.window.registerTreeDataProvider('forest.shortcuts', shortcutsProvider),
  );

  // Update noTrees context
  const updateNoTrees = async () => {
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, repoPath);
    vscode.commands.executeCommand('setContext', 'forest.noTrees', trees.length === 0);
  };
  updateNoTrees().catch(() => { });

  const ctx: ForestContext = {
    config, repoPath, stateManager, shortcutManager,
    statusBarManager, forestProvider, outputChannel, currentTree,
  };
  forestProvider.setContext(ctx);

  // Pre-warm tree data cache so the sidebar renders instantly on first open.
  forestProvider.refresh();

  // Warm the automerge detection cache so the ship buttons render correctly without a network wait.
  if (config.github.enabled) {
    gh.repoHasAutomerge(repoPath).then(() => forestProvider.refresh()).catch(() => {});
  }

  // Register commands — wrap all handlers so unhandled errors become visible
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try { return await fn(...args); } catch (e: any) {
        outputChannel.appendLine(`[Forest] Command ${id} failed: ${e.stack ?? e.message}`);
        outputChannel.show(true);
        notify.error(`Forest: ${e.message}`);
      }
    }));

  const lookupTree = (branch?: string) =>
    branch ? stateManager.getTree(stateManager.getCached(), repoPath, branch) : undefined;
  const andRefresh = <T>(fn: () => Promise<T>) => async () => { await fn(); forestProvider.refreshTrees(); };

  reg('forest.create', () => ctx.forestProvider.showCreateForm());
  reg('forest.start', (arg: { ticketId: string; title: string }) => start(ctx, arg));
  reg('forest.switch', (branch?: string) => switchTree(ctx, branch));
  reg('forest.ship', (branch?: string) => andRefresh(() => ship(ctx, lookupTree(branch), false))());
  reg('forest.shipMerge', (branch?: string) => andRefresh(() => ship(ctx, lookupTree(branch), true))());
  reg('forest.deleteTree', (branch?: string, isDone?: boolean) => deleteTree(ctx, branch, isDone ?? false));
  reg('forest.update', () => andRefresh(() => update(ctx))());
  reg('forest.rebase', () => andRefresh(() => rebase(ctx))());
  reg('forest.pull', () => andRefresh(() => pull(ctx))());
  reg('forest.push', () => andRefresh(() => push(ctx))());
  reg('forest.list', () => list(ctx));
  reg('forest.openMain', () => focusOrOpenWindow(vscode.Uri.file(repoPath)));
  reg('forest.refresh', () => forestProvider.refresh());
  reg('forest.copyBranch', () => {
    if (ctx.currentTree) vscode.env.clipboard.writeText(ctx.currentTree.branch);
  });
  reg('forest.revealInFinder', () => {
    if (ctx.currentTree?.path) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(ctx.currentTree.path));
  });
  reg('forest.openPR', () => {
    if (ctx.currentTree?.prUrl) vscode.env.openExternal(vscode.Uri.parse(ctx.currentTree.prUrl));
  });
  reg('forest.openTicket', async () => {
    if (!ctx.currentTree?.ticketId) return;
    const issue = await linear.getIssue(ctx.currentTree.ticketId);
    if (issue?.url) vscode.env.openExternal(vscode.Uri.parse(issue.url));
  });
  reg('forest.linkTicket', (branch?: string) => {
    const b = branch ?? ctx.currentTree?.branch;
    if (b) return andRefresh(() => linkTicket(ctx, b))();
  });
  const unwrap = (arg: any) => arg instanceof ShortcutItem ? arg.shortcut : arg;
  reg('forest.openShortcut', (arg: any) => shortcutManager.open(unwrap(arg)));
  reg('forest.openShortcutWith', (arg: any) => shortcutManager.openWith(unwrap(arg)));


  // Refresh when window gains focus (cross-window coordination)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(e => {
      if (e.focused) { forestProvider.refresh(); }
    }),
  );

  // If this is a tree window, run onNewTree shortcuts and show tree-specific UI.
  // For dev-container trees, VS Code first activates locally, then reloads into the
  // container — gate on env match so we don't show/run anything during the brief
  // pre-attach local activation that gets thrown away.
  if (currentTree) {
    const wsScheme = vscode.workspace.workspaceFolders?.[0]?.uri.scheme;
    const isRemoteWs = !!wsScheme && wsScheme !== 'file';
    const expectingRemote = !!currentTree.useDevcontainer;
    if (isRemoteWs === expectingRemote) {
      statusBarManager.show();
      if (currentTree.needsSetup) {
        shortcutManager.openNewTreeShortcuts();
        await stateManager.updateTree(repoPath, currentTree.branch, { needsSetup: undefined });
      }
      vscode.commands.executeCommand('forest.trees.focus');
    }
  }

  // Helper: setInterval with a guard flag to prevent overlapping runs
  const guardedInterval = (fn: () => Promise<void>, ms: number) => {
    let running = false;
    const id = setInterval(async () => {
      if (running) return;
      running = true;
      try { await fn(); } catch { /* guarded */ } finally { running = false; }
    }, ms);
    return { dispose: () => clearInterval(id) };
  };

  // Auto-cleanup polling: check merged PRs every 5 minutes
  // Only notify in the tree's own window or the main (non-tree) window.
  context.subscriptions.push(guardedInterval(async () => {
    if (!(await gh.isAvailable())) return;
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, repoPath);
    const candidates = trees.filter(tree => {
      if (!tree.prUrl || !tree.path || tree.mergeNotified) return false;
      return ctx.currentTree?.branch === tree.branch || !ctx.currentTree;
    });
    if (!candidates.length) return;
    const mergedResults = await Promise.allSettled(
      candidates.map(tree => gh.prIsMerged(tree.repoPath, tree.branch).then(merged => ({ tree, merged }))),
    );
    for (const result of mergedResults) {
      if (result.status !== 'fulfilled' || !result.value.merged) continue;
      const tree = result.value.tree;
      const isOwnWindow = ctx.currentTree?.branch === tree.branch;
      await stateManager.updateTree(tree.repoPath, tree.branch, { mergeNotified: true });
      const name = tree.ticketId ?? tree.branch;
      const detail = [tree.ticketId && config.linear.enabled && `move ${tree.ticketId} → ${config.linear.statuses.onCleanup}`, 'remove worktree + branch', isOwnWindow && 'close window'].filter(Boolean).join(', ');
      const action = await vscode.window.showInformationMessage(
        `${name} PR was merged. Cleanup will ${detail}.`,
        'Cleanup', 'Dismiss',
      );
      if (action === 'Cleanup') await cleanupMerged(ctx, tree);
    }
  }, 5 * 60 * 1000));

  // Periodic orphan check: detect worktree folders deleted externally
  context.subscriptions.push(guardedInterval(async () => {
    const before = stateManager.getTreesForRepo(await stateManager.load(), repoPath).length;
    const afterState = await pruneOrphans();
    const after = stateManager.getTreesForRepo(afterState, repoPath).length;
    if (after < before) forestProvider.refresh();
  }, 60_000));

  // Auto-refresh tree health every 3 minutes (PR status, commits behind, age)
  const healthId = setInterval(() => forestProvider.refreshTrees(), 3 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(healthId) });

  // Watch state for changes from other windows
  let previousTrees = stateManager.getTreesForRepo(postPruneState, repoPath);
  stateManager.onDidChange(({ state: newState, isLocal }) => {
    if (ctx.currentTree) {
      const updated = stateManager.getTree(newState, repoPath, ctx.currentTree.branch);
      if (updated) {
        // Another window started deleting our tree — close now so a dev container
        // window detaches gracefully before its container is killed.
        if (updated.cleaning && !isLocal) {
          vscode.commands.executeCommand('workbench.action.closeWindow');
          return;
        }
        ctx.currentTree = updated;
        statusBarManager.update(updated);
      } else {
        // Our tree was removed by another window — close this window
        vscode.commands.executeCommand('workbench.action.closeWindow');
        return;
      }
    }
    const currentTrees = stateManager.getTreesForRepo(newState, repoPath);
    // Clean up workspace files for trees removed by another window.
    // Skip for local writes — the initiating command handles its own cleanup.
    if (!isLocal) {
      const currentBranches = new Set(currentTrees.map(t => t.branch));
      for (const prev of previousTrees) {
        if (prev.branch === ctx.currentTree?.branch) continue;
        if (!currentBranches.has(prev.branch)) {
          deleteWorkspaceFiles(prev);
        }
      }
    }
    previousTrees = currentTrees;
    forestProvider.refresh();
    updateNoTrees().catch(() => {});
  });

  context.subscriptions.push(outputChannel, shortcutManager, shortcutsProvider, statusBarManager, stateManager, forestProvider);
}

export function deactivate() { }
