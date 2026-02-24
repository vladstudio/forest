import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { IssueItem, ShortcutItem, StageGroupItem, TreeItemView } from './views/items';
import { StateManager } from './state';
import { ForestContext, getRepoPath } from './context';
import { ShortcutManager } from './managers/ShortcutManager';
import { StatusBarManager } from './managers/StatusBarManager';
import { ForestTreeProvider } from './views/ForestTreeProvider';
import { ShortcutsTreeProvider } from './views/ShortcutsTreeProvider';
import { create, start } from './commands/create';
import { switchTree } from './commands/switch';
import { ship } from './commands/ship';
import { cleanup, cancel, cleanupMerged, shelve, resume } from './commands/cleanup';
import { update, rebase } from './commands/update';
import { list } from './commands/list';
import { warmTemplate, workspaceFilePath } from './commands/shared';
import * as git from './cli/git';
import * as gh from './cli/gh';
import * as linear from './cli/linear';
import { initLogger, log } from './logger';

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
  const ghAvailable = await gh.isAvailable();
  vscode.commands.executeCommand('setContext', 'forest.ghAvailable', ghAvailable);
  if (!ghAvailable) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('forest.ghMissing', emptyProvider),
    );
    return;
  }
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.linear.enabled);
  vscode.commands.executeCommand('setContext', 'forest.multipleBrowsers', config.browser.length > 1);
  vscode.commands.executeCommand('setContext', 'forest.multipleTerminals', config.terminal.length > 1);
  linear.configure(config.linear.apiKey);

  // Watch config files for external edits
  const repoPath = getRepoPath();
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.join(repoPath, '.forest'), '{config,local}.json'),
  );
  let configDebounce: ReturnType<typeof setTimeout> | undefined;
  const onConfigChange = () => {
    clearTimeout(configDebounce);
    configDebounce = setTimeout(() => {
      vscode.window.showInformationMessage(
        'Forest config changed. Reload to apply?',
        'Reload Window',
      ).then(action => {
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

  const logger = config.logging ? initLogger() : undefined;
  log.info(`Activated — repo: ${repoPath}, linear: ${config.linear.enabled}, gh: ${ghAvailable}`);

  const outputChannel = vscode.window.createOutputChannel('Forest');

  /** Prune trees whose worktree folders no longer exist on disk. Returns latest state. */
  const pruneOrphans = async (): Promise<import('./state').ForestState> => {
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, repoPath);
    for (const tree of trees) {
      if (tree.path && !fs.existsSync(tree.path)) {
        log.warn(`Pruning orphan: ${tree.branch} (${tree.path} missing)`);
        outputChannel.appendLine(`[Forest] Pruning orphan: ${tree.branch} (${tree.path} missing)`);
        await stateManager.removeTree(tree.repoPath, tree.branch);
        try { fs.unlinkSync(workspaceFilePath(tree.repoPath, tree.branch)); } catch {}
        git.deleteBranch(tree.repoPath, tree.branch).catch(() => {});
      }
    }
    return stateManager.load();
  };

  const postPruneState = await pruneOrphans();

  // Detect if current workspace is a tree (reuse state after pruning)
  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const currentTree = curPath ? Object.values(postPruneState.trees).find(t => t.path === curPath) : undefined;
  log.info(`Window: ${curPath ?? '(none)'}, tree: ${currentTree?.branch ?? '(main)'}`);

  vscode.commands.executeCommand('setContext', 'forest.isTree', !!currentTree);

  const shortcutManager = new ShortcutManager(config, currentTree);
  const statusBarManager = new StatusBarManager(currentTree);
  const forestProvider = new ForestTreeProvider(stateManager, config, context.globalState);
  const shortcutsProvider = new ShortcutsTreeProvider(config, shortcutManager);
  const forestView = vscode.window.createTreeView('forest.trees', { treeDataProvider: forestProvider });
  forestView.onDidCollapseElement(e => {
    if (e.element instanceof StageGroupItem) forestProvider.setCollapsed(e.element.label as string, true);
  });
  forestView.onDidExpandElement(e => {
    if (e.element instanceof StageGroupItem) forestProvider.setCollapsed(e.element.label as string, false);
  });
  context.subscriptions.push(
    forestView,
    vscode.window.registerTreeDataProvider('forest.shortcuts', shortcutsProvider),
  );

  // Update noTrees context + sidebar badge
  const updateNoTrees = async () => {
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, getRepoPath());
    vscode.commands.executeCommand('setContext', 'forest.noTrees', trees.length === 0);
    forestView.badge = trees.length ? { value: trees.length, tooltip: `${trees.length} trees` } : undefined;
  };
  updateNoTrees();

  const ctx: ForestContext = {
    config, stateManager, shortcutManager,
    statusBarManager, forestProvider, outputChannel, currentTree,
  };

  // Register commands — wrap all handlers so unhandled errors become visible
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try { return await fn(...args); } catch (e: any) {
        log.error(`Command ${id} failed: ${e.stack ?? e.message}`);
        outputChannel.appendLine(`[Forest] Command ${id} failed: ${e.stack ?? e.message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Forest: ${e.message}`);
      }
    }));

  reg('forest.create', () => create(ctx));
  reg('forest.start', (arg: IssueItem | { ticketId: string; title: string }) =>
    start(ctx, arg instanceof IssueItem ? { ticketId: arg.issue.id, title: arg.issue.title } : arg));
  reg('forest.switch', (arg?: string | TreeItemView) => switchTree(ctx, arg instanceof TreeItemView ? arg.tree.branch : arg));
  const andRefresh = <T>(fn: () => Promise<T>) => async () => { await fn(); forestProvider.refreshTrees(); };
  reg('forest.ship', (arg?: TreeItemView) => andRefresh(() => ship(ctx, arg instanceof TreeItemView ? arg.tree : undefined))());
  reg('forest.cleanup', (arg?: string | TreeItemView) => cleanup(ctx, arg instanceof TreeItemView ? arg.tree.branch : arg));
  reg('forest.cancel', (arg?: string | TreeItemView) => cancel(ctx, arg instanceof TreeItemView ? arg.tree.branch : arg));
  reg('forest.shelve', (arg?: string | TreeItemView) => shelve(ctx, arg instanceof TreeItemView ? arg.tree.branch : arg));
  reg('forest.resume', (arg?: string | TreeItemView) => resume(ctx, arg instanceof TreeItemView ? arg.tree.branch : arg));
  reg('forest.update', (arg?: TreeItemView) => andRefresh(() => update(ctx, arg instanceof TreeItemView ? arg.tree : undefined))());
  reg('forest.rebase', (arg?: TreeItemView) => andRefresh(() => rebase(ctx, arg instanceof TreeItemView ? arg.tree : undefined))());
  reg('forest.list', () => list(ctx));
  reg('forest.warmTemplate', () => warmTemplate());
  reg('forest.openMain', () => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(getRepoPath()), { forceNewWindow: true }));
  reg('forest.refresh', () => forestProvider.refresh());
  reg('forest.copyBranch', (arg?: TreeItemView) => {
    const tree = arg instanceof TreeItemView ? arg.tree : ctx.currentTree;
    if (tree) vscode.env.clipboard.writeText(tree.branch);
  });
  reg('forest.openPR', (arg?: TreeItemView) => {
    const tree = arg instanceof TreeItemView ? arg.tree : ctx.currentTree;
    if (tree?.prUrl) vscode.env.openExternal(vscode.Uri.parse(tree.prUrl));
  });
  const unwrap = (arg: any) => arg instanceof ShortcutItem ? arg.shortcut : arg;
  reg('forest.openShortcut', (arg: any) => shortcutManager.open(unwrap(arg)));
  reg('forest.openShortcutWith', (arg: any) => shortcutManager.openWith(unwrap(arg)));
  reg('forest.stopShortcut', (arg: any) => shortcutManager.stop(unwrap(arg)));
  reg('forest.restartShortcut', (arg: any) => shortcutManager.restart(unwrap(arg)));

  // If this is a tree window, open launch shortcuts
  if (currentTree) {
    statusBarManager.show();
    shortcutManager.openOnLaunchShortcuts();
    vscode.commands.executeCommand('forest.trees.focus');
  }

  // Auto-cleanup polling: check merged PRs every 5 minutes
  // Only notify in the tree's own window or the main (non-tree) window.
  let autoCleanupRunning = false;
  const autoCleanupInterval = setInterval(async () => {
    if (autoCleanupRunning) return;
    autoCleanupRunning = true;
    try {
      if (!(await gh.isAvailable())) return;
      const s = await stateManager.load();
      const trees = stateManager.getTreesForRepo(s, getRepoPath());
      for (const tree of trees) {
        if (!tree.prUrl || !tree.path || tree.mergeNotified) continue;
        const isOwnWindow = ctx.currentTree?.branch === tree.branch;
        const isMainWindow = !ctx.currentTree;
        if (!isOwnWindow && !isMainWindow) continue;
        if (await gh.prIsMerged(tree.repoPath, tree.branch)) {
          log.info(`PR merged detected: ${tree.branch}`);
          await stateManager.updateTree(tree.repoPath, tree.branch, { mergeNotified: true });
          const name = tree.ticketId ?? tree.branch;
          const action = await vscode.window.showInformationMessage(
            `${name} PR was merged. Clean up?`,
            'Cleanup', 'Dismiss',
          );
          if (action === 'Cleanup') await cleanupMerged(ctx, tree);
        }
      }
    } finally {
      autoCleanupRunning = false;
    }
  }, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(autoCleanupInterval) });

  // Periodic orphan check: detect worktree folders deleted externally
  let orphanCheckRunning = false;
  const orphanCheckInterval = setInterval(async () => {
    if (orphanCheckRunning) return;
    orphanCheckRunning = true;
    try {
      const before = stateManager.getTreesForRepo(stateManager.loadSync(), repoPath).length;
      await pruneOrphans();
      const after = stateManager.getTreesForRepo(stateManager.loadSync(), repoPath).length;
      if (after < before) forestProvider.refresh();
    } finally {
      orphanCheckRunning = false;
    }
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(orphanCheckInterval) });

  // Auto-refresh tree health every 3 minutes (PR status, commits behind, age)
  const healthRefreshInterval = setInterval(() => forestProvider.refreshTrees(), 3 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(healthRefreshInterval) });

  // Watch state for changes from other windows
  let previousTrees = stateManager.getTreesForRepo(stateManager.loadSync(), getRepoPath());
  stateManager.onDidChange((newState) => {
    if (ctx.currentTree) {
      const updated = stateManager.getTree(newState, getRepoPath(), ctx.currentTree.branch);
      if (updated) {
        ctx.currentTree = updated;
        statusBarManager.update(updated);
        shortcutManager.updateTree(updated);
      }
    }
    // Clean up git artifacts for trees removed by other windows.
    const currentTrees = stateManager.getTreesForRepo(newState, getRepoPath());
    const currentBranches = new Set(currentTrees.map(t => t.branch));
    for (const prev of previousTrees) {
      if (prev.branch === ctx.currentTree?.branch) continue;
      if (!currentBranches.has(prev.branch)) {
        log.info(`Tree removed by other window: ${prev.branch}`);
        try { fs.unlinkSync(workspaceFilePath(prev.repoPath, prev.branch)); } catch {}
        if (prev.path) {
          git.removeWorktree(prev.repoPath, prev.path)
            .then(() => {
              outputChannel.appendLine(`[Forest] Cleaned worktree: ${prev.branch}`);
              return git.deleteBranch(prev.repoPath, prev.branch);
            })
            .then(() => outputChannel.appendLine(`[Forest] Deleted branch: ${prev.branch}`))
            .catch(e => outputChannel.appendLine(`[Forest] Cleanup failed (${prev.branch}): ${e.message}`));
        }
      }
    }
    previousTrees = currentTrees;
    forestProvider.refresh();
    updateNoTrees();
  });

  context.subscriptions.push(outputChannel, shortcutManager, shortcutsProvider, statusBarManager, stateManager);
  if (logger) context.subscriptions.push(logger);
}

export function deactivate() {}
