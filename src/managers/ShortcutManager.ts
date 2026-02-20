import * as net from 'net';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import type { ForestConfig, ShortcutConfig } from '../config';
import type { TreeState } from '../state';
import { shellEscape } from '../utils/slug';

function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: 'localhost' });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export class ShortcutManager {
  private terminals = new Map<string, vscode.Terminal[]>();
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private pendingRestart?: vscode.Disposable;
  private disposed = false;
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

  open(sc: ShortcutConfig, viewColumn?: vscode.ViewColumn): void {
    switch (sc.type) {
      case 'terminal': return this.openTerminal(sc);
      case 'browser': return void this.openBrowser(sc, viewColumn);
      case 'file': return void this.openFile(sc);
    }
  }

  async openWith(sc: ShortcutConfig): Promise<void> {
    const items = sc.type === 'terminal' ? this.config.terminal : sc.type === 'browser' ? this.config.browser : [];
    if (items.length === 0) return;
    const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: `Open "${sc.name}" with…` });
    if (!picked) return;
    if (sc.type === 'browser') this.openBrowser(sc, undefined, picked);
    else if (sc.type === 'terminal') this.openTerminal(sc, undefined, picked);
  }

  stop(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    const list = this.terminals.get(sc.name);
    if (list) for (const t of [...list]) t.dispose();
  }

  restart(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    this.pendingRestart?.dispose();
    const sub = vscode.window.onDidCloseTerminal(t => {
      if (t.name === sc.name) {
        sub.dispose();
        this.pendingRestart = undefined;
        this.open(sc);
      }
    });
    this.pendingRestart = sub;
    this.stop(sc);
  }

  async openOnLaunchShortcuts(): Promise<void> {
    if (!this.currentTree) return;
    // Adopt existing terminals
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

    for (const sc of this.config.shortcuts) {
      if (!sc.openOnLaunch) continue;
      if (sc.type === 'terminal') {
        const viewCol = typeof sc.openOnLaunch === 'number' && sc.openOnLaunch > 1 ? sc.openOnLaunch as vscode.ViewColumn : undefined;
        const existing = this.terminals.get(sc.name);
        if (!existing || existing.length === 0) this.openTerminal(sc, viewCol);
      } else {
        this.open(sc, sc.openOnLaunch as vscode.ViewColumn);
      }
    }
    this._onDidChange.fire();
  }

  private openTerminal(sc: ShortcutConfig & { type: 'terminal' }, location?: vscode.ViewColumn, terminalApp?: string): void {
    terminalApp ??= this.config.terminal[0];
    if (terminalApp !== 'integrated') {
      this.openExternalTerminal(sc, terminalApp);
      return;
    }

    const list = this.terminals.get(sc.name) ?? [];
    const mode = sc.mode ?? 'single-tree';

    if (mode === 'single-tree' && list.length > 0) { list[0].show(); return; }
    if (mode === 'single-repo') {
      for (const t of [...list]) t.dispose();
      list.length = 0;
    }

    const env: Record<string, string> = {};
    if (sc.env) {
      for (const [k, v] of Object.entries(sc.env)) {
        env[k] = this.resolveVars(v);
      }
    }
    const terminal = vscode.window.createTerminal({
      name: sc.name,
      cwd: this.currentTree?.path,
      env,
      ...(location ? { location: { viewColumn: location } } : {}),
    });
    terminal.show(false);
    if (sc.command) terminal.sendText(this.resolveVars(sc.command, true));
    list.push(terminal);
    this.terminals.set(sc.name, list);
    this._onDidChange.fire();
  }

  private openExternalTerminal(sc: ShortcutConfig & { type: 'terminal' }, app: string): void {
    const cwd = this.currentTree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const cmd = sc.command ? this.resolveVars(sc.command, true) : undefined;
    const script = cmd ? `cd ${shellEscape(cwd)} && ${cmd}` : `cd ${shellEscape(cwd)}`;
    const lowerApp = app.toLowerCase();

    if (lowerApp === 'iterm' || lowerApp === 'iterm2') {
      cp.execFile('osascript', ['-e', `tell application "iTerm" to create window with default profile command ${JSON.stringify(script)}`], { timeout: 5000 }).unref();
    } else if (lowerApp === 'terminal' || lowerApp === 'terminal.app') {
      cp.execFile('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], { timeout: 5000 }).unref();
    } else if (lowerApp === 'ghostty') {
      cp.spawn('ghostty', ['--working-directory', cwd, ...(cmd ? ['-e', cmd] : [])], { detached: true, stdio: 'ignore' }).unref();
    } else {
      cp.spawn('open', ['-a', app, cwd], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  private async openBrowser(sc: ShortcutConfig & { type: 'browser' }, viewColumn?: vscode.ViewColumn, browser?: string): Promise<void> {
    const url = this.resolveVars(sc.url);
    browser ??= sc.browser ?? this.config.browser[0];
    const port = this.extractPort(url);
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);

    if (port && isLocalhost) {
      await this.waitAndOpenBrowser(port, url, browser, viewColumn);
    } else {
      this.openUrl(url, browser, viewColumn);
    }
  }

  private async waitAndOpenBrowser(port: number, url: string, browser: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    if (await isPortOpen(port)) { this.openUrl(url, browser, viewColumn); return; }

    const timeout = 120_000;
    const start = Date.now();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Waiting for port ${port}…`, cancellable: true },
      (_progress, token) => new Promise<void>(resolve => {
        const check = async (): Promise<void> => {
          if (this.disposed || token.isCancellationRequested) { resolve(); return; }
          if (Date.now() - start > timeout) {
            resolve();
            const c = await vscode.window.showWarningMessage(`Timed out waiting for port ${port}.`, 'Open Anyway');
            if (c) this.openUrl(url, browser, viewColumn);
            return;
          }
          if (await isPortOpen(port)) { resolve(); this.openUrl(url, browser, viewColumn); return; }
          const timer = setTimeout(() => { this.pendingTimers.delete(timer); check(); }, 2000);
          this.pendingTimers.add(timer);
        };
        check();
      }),
    );
  }

  private async openUrl(url: string, browser: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    if (browser === 'external') {
      vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (browser === 'simple') {
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
      cp.spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    }
  }

  private async openFile(sc: ShortcutConfig & { type: 'file' }): Promise<void> {
    const base = this.currentTree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) return;
    const resolved = this.resolveVars(sc.path);
    const filePath = path.isAbsolute(resolved) ? resolved : path.join(base, resolved);
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

  private resolveVars(value: string, forShell = false): string {
    if (!this.currentTree) return value;
    const tree = this.currentTree;
    const ticketId = tree.ticketId ?? '';
    const slug = ticketId && tree.branch.startsWith(ticketId)
      ? tree.branch.slice(ticketId.length).replace(/^-/, '')
      : tree.branch;
    const prNumber = tree.prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? '';
    const esc = forShell ? shellEscape : (v: string) => v;
    return value
      .replace(/\$\{ticketId\}/g, esc(ticketId))
      .replace(/\$\{branch\}/g, esc(tree.branch))
      .replace(/\$\{repo\}/g, esc(path.basename(tree.repoPath)))
      .replace(/\$\{treePath\}/g, esc(tree.path ?? ''))
      .replace(/\$\{slug\}/g, esc(slug))
      .replace(/\$\{prNumber\}/g, esc(prNumber))
      .replace(/\$\{prUrl\}/g, esc(tree.prUrl ?? ''));
  }

  private extractPort(url: string): number | null {
    const m = url.match(/:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  updateTree(tree: TreeState): void {
    this.currentTree = tree;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.pendingTimers.clear();
    this.pendingRestart?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
