import * as vscode from 'vscode';
import { loadConfig } from './config';
import { IssueItem, ShortcutItem, TreeItemView } from './views/items';
import { StateManager } from './state';
import { ForestContext, getRepoPath } from './context';
import { PortManager } from './managers/PortManager';
import { ShortcutManager } from './managers/ShortcutManager';
import { StatusBarManager } from './managers/StatusBarManager';
import { IssuesTreeProvider } from './views/IssuesTreeProvider';
import { TreesTreeProvider } from './views/TreesTreeProvider';
import { ShortcutsTreeProvider } from './views/ShortcutsTreeProvider';
import { newIssueTree } from './commands/newIssueTree';
import { newTree } from './commands/newTree';
import { switchTree } from './commands/switch';
import { ship } from './commands/ship';
import { cleanup, cancel, cleanupMerged } from './commands/cleanup';
import { update } from './commands/update';
import { list } from './commands/list';
import { commit } from './commands/commit';
import { warmTemplate } from './commands/shared';
import * as git from './cli/git';
import * as gh from './cli/gh';

export async function activate(context: vscode.ExtensionContext) {
  const config = await loadConfig();
  if (!config) {
    // Register empty provider so the setup welcome message is shown
    const emptyProvider: vscode.TreeDataProvider<never> = {
      getTreeItem: () => { throw new Error('no items'); },
      getChildren: () => [],
    };
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('forest.setup', emptyProvider),
      vscode.commands.registerCommand('forest.copySetupPrompt', () => {
        vscode.env.clipboard.writeText('Set up Forest (https://github.com/vladstudio/forest) for this project. Create .forest/config.json with the required configuration.');
        vscode.window.showInformationMessage('Copied to clipboard');
      }),
    );
    return;
  }

  vscode.commands.executeCommand('setContext', 'forest.active', true);
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.linear.enabled);

  const stateManager = new StateManager();
  await stateManager.initialize();

  // Detect if current workspace is a tree
  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const state = stateManager.loadSync();
  const currentTree = curPath ? Object.values(state.trees).find(t => t.path === curPath) : undefined;

  vscode.commands.executeCommand('setContext', 'forest.isTree', !!currentTree);

  const outputChannel = vscode.window.createOutputChannel('Forest');
  const portManager = new PortManager(config, stateManager);
  const shortcutManager = new ShortcutManager(config, currentTree, stateManager);
  const statusBarManager = new StatusBarManager(currentTree);
  const issuesProvider = new IssuesTreeProvider(config, stateManager);
  const treesProvider = new TreesTreeProvider(stateManager, config);
  const shortcutsProvider = new ShortcutsTreeProvider(config, shortcutManager);
  const treesView = vscode.window.createTreeView('forest.trees', { treeDataProvider: treesProvider });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forest.issues', issuesProvider),
    treesView,
    vscode.window.registerTreeDataProvider('forest.shortcuts', shortcutsProvider),
  );

  // Update noTrees context + sidebar badge
  const updateNoTrees = async () => {
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, getRepoPath());
    vscode.commands.executeCommand('setContext', 'forest.noTrees', trees.length === 0);
    treesView.badge = trees.length ? { value: trees.length, tooltip: `${trees.length} trees` } : undefined;
  };
  updateNoTrees();

  const ctx: ForestContext = {
    config, stateManager, portManager, shortcutManager,
    statusBarManager, issuesProvider, treesProvider, outputChannel, currentTree,
  };

  // Register commands
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('forest.newIssueTree', () => newIssueTree(ctx));
  reg('forest.newTree', (arg?: string | IssueItem) => newTree(ctx, arg instanceof IssueItem ? { ticketId: arg.issue.id, title: arg.issue.title } : arg));
  reg('forest.newTreePicker', async () => {
    const pick = await vscode.window.showQuickPick([
      { label: '$(add) New Linear Issue + Tree', id: 'issue' },
      { label: '$(git-branch) New Tree', id: 'tree' },
    ], { placeHolder: 'Create a new tree' });
    if (pick?.id === 'issue') newIssueTree(ctx);
    else if (pick?.id === 'tree') newTree(ctx);
  });
  reg('forest.switch', (arg?: string | TreeItemView) => switchTree(ctx, arg instanceof TreeItemView ? arg.tree.ticketId : arg));
  const andRefresh = <T>(fn: () => Promise<T>) => async () => { await fn(); treesProvider.refresh(); };
  reg('forest.ship', (arg?: TreeItemView) => andRefresh(() => ship(ctx, arg instanceof TreeItemView ? arg.tree : undefined))());
  reg('forest.cleanup', (arg?: string | TreeItemView) => cleanup(ctx, arg instanceof TreeItemView ? arg.tree.ticketId : arg));
  reg('forest.cancel', (arg?: string | TreeItemView) => cancel(ctx, arg instanceof TreeItemView ? arg.tree.ticketId : arg));
  reg('forest.update', (arg?: TreeItemView) => andRefresh(() => update(ctx, arg instanceof TreeItemView ? arg.tree : undefined))());
  reg('forest.list', () => list(ctx));
  reg('forest.commit', () => commit(ctx));
  reg('forest.warmTemplate', () => warmTemplate());
  reg('forest.refreshIssues', () => issuesProvider.refresh());
  reg('forest.refreshTrees', () => treesProvider.refresh());
  reg('forest.copyBranch', (arg?: TreeItemView) => {
    const tree = arg instanceof TreeItemView ? arg.tree : ctx.currentTree;
    if (tree) vscode.env.clipboard.writeText(tree.branch);
  });
  const unwrap = (arg: any) => arg instanceof ShortcutItem ? arg.shortcut : arg;
  reg('forest.openShortcut', (arg: any) => shortcutManager.open(unwrap(arg)));
  reg('forest.stopShortcut', (arg: any) => shortcutManager.stop(unwrap(arg)));
  reg('forest.restartShortcut', (arg: any) => shortcutManager.restart(unwrap(arg)));

  // If this is a tree window, open launch shortcuts + auto-cleanup polling
  if (currentTree) {
    statusBarManager.show();
    shortcutManager.openOnLaunchShortcuts();
    vscode.commands.executeCommand('forest.trees.focus');

  }

  // Auto-cleanup polling: check merged PRs every 5 minutes
  let autoCleanupRunning = false;
  const autoCleanupInterval = setInterval(async () => {
    if (autoCleanupRunning) return;
    autoCleanupRunning = true;
    try {
      if (!(await gh.isAvailable())) return;
      const s = await stateManager.load();
      const trees = stateManager.getTreesForRepo(s, getRepoPath());
      for (const tree of trees) {
        if (!tree.prUrl) continue;
        if (await gh.prIsMerged(tree.repoPath, tree.branch)) {
          const action = await vscode.window.showInformationMessage(
            `${tree.ticketId} PR was merged. Clean up?`,
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

  // Watch state for changes from other windows
  let previousTrees = stateManager.getTreesForRepo(stateManager.loadSync(), getRepoPath());
  stateManager.onDidChange((newState) => {
    if (ctx.currentTree) {
      const updated = stateManager.getTree(newState, getRepoPath(), ctx.currentTree.ticketId);
      if (updated) {
        ctx.currentTree = updated;
        statusBarManager.update(updated);
        shortcutManager.updateTree(updated);
      }
    }
    // Clean up git artifacts for trees removed by other windows.
    // All windows participate — operations are idempotent, races are harmless.
    const currentTrees = stateManager.getTreesForRepo(newState, getRepoPath());
    const currentIds = new Set(currentTrees.map(t => t.ticketId));
    for (const prev of previousTrees) {
      // Skip self — teardownTree handles our own window
      if (prev.ticketId === currentTree?.ticketId) continue;
      if (!currentIds.has(prev.ticketId)) {
        git.removeWorktree(prev.repoPath, prev.path)
          .then(() => {
            outputChannel.appendLine(`[Forest] Cleaned worktree: ${prev.ticketId}`);
            return git.deleteBranch(prev.repoPath, prev.branch);
          })
          .then(() => outputChannel.appendLine(`[Forest] Deleted branch: ${prev.branch}`))
          .catch(e => outputChannel.appendLine(`[Forest] Cleanup failed (${prev.ticketId}): ${e.message}`));
      }
    }
    previousTrees = currentTrees;
    issuesProvider.refresh();
    treesProvider.refresh();
    updateNoTrees();
  });

  context.subscriptions.push(outputChannel, shortcutManager, statusBarManager, stateManager);
}

export function deactivate() {}
