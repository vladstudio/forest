import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import { type ForestConfig, type ShortcutConfig, allShortcuts } from '../config';
import type { TreeState } from '../state';
import { shellEscape } from '../utils/slug';
import { notify } from '../notify';

export class ShortcutManager implements vscode.Disposable {

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private config: ForestConfig, private currentTree: TreeState | undefined) {}

  async open(sc: ShortcutConfig, viewColumn?: vscode.ViewColumn): Promise<void> {
    switch (sc.type) {
      case 'terminal': return this.openTerminal(sc);
      case 'browser': return this.openBrowser(sc, viewColumn);
      case 'file': return this.openFile(sc);
    }
  }

  async openWith(sc: ShortcutConfig): Promise<void> {
    const items = sc.type === 'terminal' ? this.config.terminal : sc.type === 'browser' ? this.config.browser : [];
    if (items.length === 0) return;
    const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: `Open "${sc.name}" with…` });
    if (!picked) return;
    if (sc.type === 'browser') await this.openBrowser(sc, undefined, picked);
    else if (sc.type === 'terminal') await this.openTerminal(sc, undefined, picked);
  }

  /** Open shortcuts marked with onNewTree. */
  async openNewTreeShortcuts(): Promise<void> {
    await Promise.all(allShortcuts(this.config.shortcuts).filter(s => s.onNewTree).map(s => this.open(s)));
  }

  private async openTerminal(sc: ShortcutConfig & { type: 'terminal' }, location?: vscode.ViewColumn, terminalApp?: string): Promise<void> {
    terminalApp ??= this.config.terminal[0];
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const isRemoteWs = !!wsFolder && wsFolder.uri.scheme !== 'file';

    if (terminalApp !== 'integrated') {
      if (isRemoteWs) {
        notify.info(`External terminal "${terminalApp}" can't reach the dev container — using integrated.`);
      } else {
        this.openExternalTerminal(sc, terminalApp);
        return;
      }
    }

    const env: Record<string, string> = {};
    if (sc.env) {
      for (const [k, v] of Object.entries(sc.env)) {
        env[k] = v;
      }
    }
    // Pass the workspace folder URI so VS Code spawns the terminal on the correct side
    // (host or inside the dev container). Never fall back to currentTree.path — that's a
    // host path which fails inside a container.
    const cwd: vscode.Uri | undefined = wsFolder?.uri;
    const terminal = vscode.window.createTerminal({
      name: sc.name,
      cwd,
      env,
      ...(location ? { location: { viewColumn: location } } : {}),
    });
    terminal.show(false);
    vscode.commands.executeCommand('workbench.action.terminal.focus');
    if (sc.command) terminal.sendText(sc.command);
  }

  private openExternalTerminal(sc: ShortcutConfig & { type: 'terminal' }, app: string): void {
    // External terminal apps run on the host. Only reachable from non-container windows,
    // where workspaceFolders[0].fsPath is already a host path.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const cmd = sc.command;
    const lowerApp = app.toLowerCase();

    if (lowerApp === 'iterm' || lowerApp === 'iterm2') {
      const script = cmd ? `cd ${shellEscape(cwd)} && ${cmd}` : `cd ${shellEscape(cwd)}`;
      cp.execFile('osascript', ['-e', `tell application "iTerm" to create window with default profile command ${JSON.stringify(script)}`], { timeout: 5000 }).on('error', () => {}).unref();
    } else if (lowerApp === 'terminal' || lowerApp === 'terminal.app') {
      const script = cmd ? `cd ${shellEscape(cwd)} && ${cmd}` : `cd ${shellEscape(cwd)}`;
      cp.execFile('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], { timeout: 5000 }).on('error', () => {}).unref();
    } else if (lowerApp === 'ghostty') {
      cp.spawn('ghostty', ['--working-directory', cwd, ...(cmd ? ['-e', cmd] : [])], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } else {
      // Unsupported terminal — open app at cwd, command cannot be sent
      notify.warn(`Terminal "${app}" is not supported for command sending. Use iTerm, Terminal, or Ghostty.`);
      cp.spawn('open', ['-a', app, cwd], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  }

  private async openBrowser(sc: ShortcutConfig & { type: 'browser' }, viewColumn?: vscode.ViewColumn, browser?: string): Promise<void> {
    const url = sc.url.trim();
    if (!url) { notify.warn(`Cannot open "${sc.name}": URL is empty.`); return; }
    this.openUrl(url, browser ?? sc.browser ?? this.config.browser[0], viewColumn);
  }

  private async openUrl(url: string, browser: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    if (browser === 'external') {
      vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (browser === 'integrated') {
      try {
        await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), {
          viewColumn: viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: true,
        });
      } catch {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } else {
      // Custom browser command (e.g. "firefox", "/Applications/Firefox.app")
      const args = process.platform === 'darwin' ? ['-a', browser, url] : [url];
      const cmd = process.platform === 'darwin' ? 'open' : browser;
      cp.spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  }

  private async openFile(sc: ShortcutConfig & { type: 'file' }): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;
    // Use the workspace folder URI as base so the path resolves on the right side
    // (host vs dev container) and preserves URI scheme.
    const target = path.isAbsolute(sc.path)
      ? vscode.Uri.file(sc.path)
      : vscode.Uri.joinPath(wsFolder.uri, sc.path);
    await vscode.commands.executeCommand('vscode.open', target);
  }

  updateTree(tree: TreeState): void {
    this.currentTree = tree;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
