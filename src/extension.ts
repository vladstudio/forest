import * as vscode from 'vscode';
import * as path from 'path';
import { loadConfig } from './config';
import { ShortcutsTreeProvider } from './views/ShortcutsTreeProvider';
import { StateManager } from './state';
import { ForestContext } from './context';
import { getRepoPath } from './utils/repo';
import { ShortcutManager } from './managers/ShortcutManager';
import { StatusBarManager } from './managers/StatusBarManager';
import { ForestWebviewProvider } from './views/ForestWebviewProvider';
import * as gh from './cli/gh';
import * as linear from './cli/linear';
import { initializeState, pruneOrphans } from './bootstrap/state';
import { startPolling } from './bootstrap/polling';
import { registerCommands } from './bootstrap/commands';
import { deleteWorkspaceFiles } from './commands/shared';
import { focusOrOpenWindow } from './commands/shared';

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

  // Validate Linear config statuses
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
  const outputChannel = vscode.window.createOutputChannel('Forest');

  // State init + orphan recovery
  const postPruneState = await initializeState({ config, repoPath, stateManager, outputChannel } as ForestContext);

  // Detect current tree
  const curPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const currentTree = curPath ? Object.values(postPruneState.trees).find(t => t.path === curPath) : undefined;
  vscode.commands.executeCommand('setContext', 'forest.isTree', !!currentTree);

  const shortcutManager = new ShortcutManager(config, currentTree);
  const statusBarManager = new StatusBarManager(currentTree);
  const forestProvider = new ForestWebviewProvider(stateManager, config, context.extensionUri);
  const shortcutsProvider = new ShortcutsTreeProvider(config, shortcutManager);
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

  // Warm-up automerge detection cache
  if (config.github.enabled) {
    gh.repoHasAutomerge(repoPath).then(() => forestProvider.refresh()).catch(() => {});
  }

  // Commands, polling, state watching
  context.subscriptions.push(
    ...registerCommands(ctx, outputChannel, shortcutsProvider),
    ...startPolling(ctx, () => pruneOrphans(stateManager, repoPath, outputChannel)),
  );

  // Refresh when window gains focus (cross-window coordination)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(e => {
      if (e.focused) { forestProvider.refresh(); }
    }),
  );

  // Adopt existing terminals
  shortcutManager.adoptTerminals();

  // If this is a tree window, run onNewTree shortcuts
  if (currentTree) {
    statusBarManager.show();
    if (currentTree.needsSetup) {
      shortcutManager.openNewTreeShortcuts();
      await stateManager.updateTree(repoPath, currentTree.branch, { needsSetup: undefined });
    }
    vscode.commands.executeCommand('forest.trees.focus');
  }

  // Watch state for changes from other windows
  let previousTrees = stateManager.getTreesForRepo(postPruneState, repoPath);
  stateManager.onDidChange(({ state: newState, isLocal }) => {
    if (ctx.currentTree) {
      const updated = stateManager.getTree(newState, repoPath, ctx.currentTree.branch);
      if (updated) {
        ctx.currentTree = updated;
        statusBarManager.update(updated);
        shortcutManager.updateTree(updated);
      } else {
        vscode.commands.executeCommand('workbench.action.closeWindow');
        return;
      }
    }
    const currentTrees = stateManager.getTreesForRepo(newState, repoPath);
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
