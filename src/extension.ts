import * as vscode from 'vscode';
import { loadConfig } from './config';
import { ShortcutItem } from './views/items';
import { StateManager, TreeState } from './state';
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
import { treeSummary } from './commands/treeSummary';
import { warmTemplate } from './commands/shared';
import * as linear from './cli/linear';
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
    );
    return;
  }

  vscode.commands.executeCommand('setContext', 'forest.active', true);
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.integrations.linear);

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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forest.issues', issuesProvider),
    vscode.window.registerTreeDataProvider('forest.trees', treesProvider),
    vscode.window.registerTreeDataProvider('forest.shortcuts', shortcutsProvider),
  );

  // Update noTrees context
  const updateNoTrees = async () => {
    const s = await stateManager.load();
    const trees = stateManager.getTreesForRepo(s, getRepoPath());
    vscode.commands.executeCommand('setContext', 'forest.noTrees', trees.length === 0);
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
  reg('forest.newTree', (ticketId?: string) => newTree(ctx, ticketId));
  reg('forest.switch', (ticketId?: string) => switchTree(ctx, ticketId));
  reg('forest.ship', () => ship(ctx));
  reg('forest.cleanup', (ticketId?: string) => cleanup(ctx, ticketId));
  reg('forest.cancel', (ticketId?: string) => cancel(ctx, ticketId));
  reg('forest.update', () => update(ctx));
  reg('forest.list', () => list(ctx));
  reg('forest.commit', () => commit(ctx));
  reg('forest.treeSummary', () => treeSummary(ctx));
  reg('forest.warmTemplate', () => warmTemplate(config));
  reg('forest.refreshIssues', () => issuesProvider.refresh());
  reg('forest.refreshTrees', () => treesProvider.refresh());
  reg('forest.copyBranch', () => {
    if (currentTree) vscode.env.clipboard.writeText(currentTree.branch);
  });
  reg('forest.openInLinear', async (ticketId?: string) => {
    const id = ticketId || currentTree?.ticketId;
    if (!id) return;
    const url = await linear.getIssueUrl(id);
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
  });
  reg('forest.setStatus', async () => {
    if (!currentTree) return;
    const pick = await vscode.window.showQuickPick(
      ['dev', 'testing', 'review', 'done'].map(s => ({ label: s })),
      { placeHolder: 'Set tree status' },
    );
    if (pick) {
      await stateManager.updateTree(getRepoPath(), currentTree.ticketId, {
        status: pick.label as TreeState['status'],
      });
    }
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

    // Auto-run tree summary if AI configured
    if (config.ai?.apiKey) {
      treeSummary(ctx);
    }
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
        if (tree.status !== 'review' || !tree.prUrl) continue;
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
  stateManager.onDidChange((newState) => {
    if (ctx.currentTree) {
      const updated = stateManager.getTree(newState, getRepoPath(), ctx.currentTree.ticketId);
      if (updated) {
        ctx.currentTree = updated;
        statusBarManager.update(updated);
        shortcutManager.updateTree(updated);
      }
    }
    issuesProvider.refresh();
    treesProvider.refresh();
    updateNoTrees();
  });

  context.subscriptions.push(outputChannel, shortcutManager, statusBarManager, stateManager);
}

export function deactivate() {}
