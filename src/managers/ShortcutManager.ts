import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import type { ForestConfig, ShortcutConfig } from '../config';
import type { TreeState } from '../state';
import { shellEscape } from '../utils/slug';

export class ShortcutManager {
  private terminals = new Map<string, vscode.Terminal[]>();
  private pendingRestarts = new Map<string, vscode.Disposable>();
  private disposables: vscode.Disposable[] = [];

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private config: ForestConfig, private currentTree: TreeState | undefined) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(t => this.handleTerminalClose(t)),
      this._onDidChange,
    );
  }

  getState(sc: ShortcutConfig): 'running' | 'stopped' | 'idle' {
    if (sc.type !== 'terminal') return 'idle';
    const list = this.terminals.get(sc.name);
    return list && list.length > 0 ? 'running' : 'stopped';
  }

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

  stop(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    const list = this.terminals.get(sc.name);
    if (list) for (const t of [...list]) t.dispose();
  }

  restart(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    this.pendingRestarts.get(sc.name)?.dispose();
    const sub = vscode.window.onDidCloseTerminal(t => {
      if (t.name === sc.name) {
        sub.dispose();
        this.pendingRestarts.delete(sc.name);
        this.open(sc);
      }
    });
    this.pendingRestarts.set(sc.name, sub);
    this.stop(sc);
  }

  /** Adopt already-open terminals so state tracking works across window reloads. */
  adoptTerminals(): void {
    for (const sc of this.config.shortcuts) {
      if (sc.type !== 'terminal') continue;
      const adopted: vscode.Terminal[] = [];
      for (const t of vscode.window.terminals) {
        if (t.name === sc.name || t.name.startsWith(`${sc.name} `)) {
          adopted.push(t);
        }
      }
      if (adopted.length > 0) this.terminals.set(sc.name, adopted);
    }
    this._onDidChange.fire();
  }

  /** Open shortcuts marked with onNewTree. */
  async openNewTreeShortcuts(): Promise<void> {
    await Promise.all(this.config.shortcuts.filter(s => s.onNewTree).map(s => this.open(s)));
  }

  private async openTerminal(sc: ShortcutConfig & { type: 'terminal' }, location?: vscode.ViewColumn, terminalApp?: string): Promise<void> {
    terminalApp ??= this.config.terminal[0];
    if (terminalApp !== 'integrated') {
      this.openExternalTerminal(sc, terminalApp);
      return;
    }

    const list = this.terminals.get(sc.name) ?? [];

    const env: Record<string, string> = {};
    if (sc.env) {
      for (const [k, v] of Object.entries(sc.env)) {
        env[k] = v;
      }
    }
    const terminal = vscode.window.createTerminal({
      name: sc.name,
      cwd: this.currentTree?.path,
      env,
      ...(location ? { location: { viewColumn: location } } : {}),
    });
    terminal.show(false);
    vscode.commands.executeCommand('workbench.action.terminal.focus');
    if (sc.command) terminal.sendText(sc.command);
    list.push(terminal);
    this.terminals.set(sc.name, list);
    this._onDidChange.fire();
  }

  private openExternalTerminal(sc: ShortcutConfig & { type: 'terminal' }, app: string): void {
    const cwd = this.currentTree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
      vscode.window.showWarningMessage(`Terminal "${app}" is not supported for command sending. Use iTerm, Terminal, or Ghostty.`);
      cp.spawn('open', ['-a', app, cwd], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  }

  private async openBrowser(sc: ShortcutConfig & { type: 'browser' }, viewColumn?: vscode.ViewColumn, browser?: string): Promise<void> {
    const url = sc.url.trim();
    if (!url) { vscode.window.showWarningMessage(`Cannot open "${sc.name}": URL is empty.`); return; }
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
    const base = this.currentTree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) return;
    const filePath = path.isAbsolute(sc.path) ? sc.path : path.join(base, sc.path);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
  }

  private handleTerminalClose(terminal: vscode.Terminal): void {
    for (const [name, list] of this.terminals) {
      const idx = list.indexOf(terminal);
      if (idx < 0) continue;
      list.splice(idx, 1);
      if (list.length === 0) this.terminals.delete(name);
      this._onDidChange.fire();
      break;
    }
  }

  updateTree(tree: TreeState): void {
    this.currentTree = tree;
    this._onDidChange.fire();
  }

  dispose(): void {
    this.pendingRestarts.forEach(d => d.dispose());
    this.pendingRestarts.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
