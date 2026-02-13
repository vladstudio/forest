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
import { seed } from './commands/seed';
import { plant } from './commands/plant';
import { switchTree } from './commands/switch';
import { ship } from './commands/ship';
import { fell } from './commands/fell';
import { water } from './commands/water';
import { survey } from './commands/survey';
import * as linear from './cli/linear';

export async function activate(context: vscode.ExtensionContext) {
  const config = await loadConfig();
  if (!config) return;

  vscode.commands.executeCommand('setContext', 'forest.active', true);
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.integrations.linear);

  const stateManager = new StateManager();
  await stateManager.initialize();

  // Detect if current workspace is a tree
  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const state = stateManager.loadSync();
  const currentTree = curPath ? Object.values(state.trees).find(t => t.path === curPath) : undefined;

  vscode.commands.executeCommand('setContext', 'forest.isTree', !!currentTree);

  const portManager = new PortManager(config, stateManager);
  const shortcutManager = new ShortcutManager(config, currentTree);
  const statusBarManager = new StatusBarManager(currentTree);
  const issuesProvider = new IssuesTreeProvider(config, stateManager);
  const treesProvider = new TreesTreeProvider(stateManager);
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
    statusBarManager, issuesProvider, treesProvider, currentTree,
  };

  // Register commands
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('forest.seed', () => seed(ctx));
  reg('forest.plant', (ticketId?: string) => plant(ctx, ticketId));
  reg('forest.switch', (ticketId?: string) => switchTree(ctx, ticketId));
  reg('forest.ship', () => ship(ctx));
  reg('forest.fell', (ticketId?: string) => fell(ctx, ticketId));
  reg('forest.water', () => water(ctx));
  reg('forest.survey', () => survey(ctx));
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

  // If this is a tree window, open launch shortcuts
  if (currentTree) {
    statusBarManager.show();
    shortcutManager.openOnLaunchShortcuts();
  }

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

  context.subscriptions.push(shortcutManager, statusBarManager, stateManager);
}

export function deactivate() {}
