import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { ShortcutItem, ShortcutsTreeProvider } from '../views/ShortcutsTreeProvider';
import { start } from '../commands/create';
import { linkTicket } from '../commands/linkTicket';
import { switchTree } from '../commands/switch';
import { ship } from '../commands/ship';
import { deleteTree } from '../commands/cleanup';
import { update, rebase, pull, push } from '../commands/update';
import { list } from '../commands/list';
import { focusOrOpenWindow } from '../commands/shared';
import * as linear from '../cli/linear';

export function registerCommands(ctx: ForestContext, outputChannel: vscode.OutputChannel, shortcutsProvider: ShortcutsTreeProvider): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const { stateManager, shortcutManager, forestProvider, repoPath } = ctx;

  const reg = (id: string, fn: (...args: any[]) => any) =>
    disposables.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (e: any) {
        // Commands handle their own notifications. This is a safety net for uncaught errors.
        outputChannel.appendLine(`[Forest] Unhandled error in ${id}: ${e.stack ?? e.message}`);
        outputChannel.show(true);
      }
    }));

  const lookupTree = async (branch?: string) =>
    branch ? stateManager.getTree(await stateManager.load(), repoPath, branch) : undefined;
  const andRefresh = <T>(fn: () => Promise<T>) => async () => { await fn(); forestProvider.refreshTrees(); };

  reg('forest.create', () => ctx.forestProvider.showCreateForm());
  reg('forest.start', (arg: { ticketId: string; title: string }) => start(ctx, arg));
  reg('forest.switch', (branch?: string) => switchTree(ctx, branch));
  reg('forest.ship', async (branch?: string) => {
    const tree = await lookupTree(branch);
    await ship(ctx, tree, false);
    forestProvider.refreshTrees();
  });
  reg('forest.shipMerge', async (branch?: string) => {
    const tree = await lookupTree(branch);
    await ship(ctx, tree, true);
    forestProvider.refreshTrees();
  });
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
  reg('forest.stopShortcut', (arg: any) => shortcutManager.stop(unwrap(arg)));
  reg('forest.restartShortcut', (arg: any) => shortcutManager.restart(unwrap(arg)));

  return disposables;
}
