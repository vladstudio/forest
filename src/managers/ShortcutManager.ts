import * as vscode from 'vscode';
import * as path from 'path';
import type { ForestConfig, ShortcutConfig } from '../config';
import type { TreeState } from '../state';
import { isPortOpen, resolvePortVars } from '../utils/ports';

export class ShortcutManager {
  private terminals = new Map<string, vscode.Terminal>();
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
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
    return this.terminals.has(sc.name) ? 'running' : 'stopped';
  }

  open(sc: ShortcutConfig, viewColumn?: vscode.ViewColumn): void {
    switch (sc.type) {
      case 'terminal': return this.openTerminal(sc);
      case 'browser': return void this.openBrowser(sc, viewColumn);
      case 'file': return void this.openFile(sc);
    }
  }

  stop(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    const t = this.terminals.get(sc.name);
    if (t) t.dispose();
  }

  restart(sc: ShortcutConfig): void {
    if (sc.type !== 'terminal') return;
    const name = sc.name;
    const sub = vscode.window.onDidCloseTerminal(t => {
      if (t.name === `[Forest] ${name}`) {
        sub.dispose();
        this.open(sc);
      }
    });
    this.disposables.push(sub);
    this.stop(sc);
  }

  openOnLaunchShortcuts(): void {
    if (!this.currentTree) return;
    // Adopt existing terminals
    const existing = new Map(vscode.window.terminals.map(t => [t.name, t]));
    for (const sc of this.config.shortcuts) {
      if (sc.type !== 'terminal') continue;
      const name = `[Forest] ${sc.name}`;
      const t = existing.get(name);
      if (t) this.terminals.set(sc.name, t);
    }

    for (const sc of this.config.shortcuts) {
      if (!sc.openOnLaunch) continue;
      if (sc.type === 'terminal') {
        if (!this.terminals.has(sc.name)) this.openTerminal(sc);
      } else {
        this.open(sc, sc.openOnLaunch as vscode.ViewColumn);
      }
    }
    this._onDidChange.fire();
  }

  private openTerminal(sc: ShortcutConfig & { type: 'terminal' }): void {
    const existing = this.terminals.get(sc.name);
    if (existing) { existing.show(); return; }

    const env: Record<string, string> = {};
    if (this.currentTree && this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        env[k] = this.resolvePorts(v);
      }
    }
    Object.assign(env, sc.env);
    const terminal = vscode.window.createTerminal({
      name: `[Forest] ${sc.name}`,
      cwd: this.currentTree?.path,
      env,
    });
    if (sc.command) terminal.sendText(sc.command);
    this.terminals.set(sc.name, terminal);
    this._onDidChange.fire();
  }

  private async openBrowser(sc: ShortcutConfig & { type: 'browser' }, viewColumn?: vscode.ViewColumn): Promise<void> {
    const url = this.resolvePorts(sc.url);
    const port = this.extractPort(url);
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);

    if (port && isLocalhost) {
      await this.waitAndOpenBrowser(port, url, viewColumn);
    } else {
      this.openSimpleBrowser(url, viewColumn);
    }
  }

  private async waitAndOpenBrowser(port: number, url: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    const timeout = 120_000;
    const start = Date.now();
    const check = async (): Promise<void> => {
      if (this.disposed) return;
      if (Date.now() - start > timeout) {
        const c = await vscode.window.showWarningMessage(`Timed out waiting for port ${port}.`, 'Open Anyway');
        if (c) this.openSimpleBrowser(url, viewColumn);
        return;
      }
      if (await isPortOpen(port)) { this.openSimpleBrowser(url, viewColumn); return; }
      const timer = setTimeout(() => { this.pendingTimers.delete(timer); check(); }, 2000);
      this.pendingTimers.add(timer);
    };
    check();
  }

  private async openSimpleBrowser(url: string, viewColumn?: vscode.ViewColumn): Promise<void> {
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), {
        viewColumn: viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: true,
      });
    } catch {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async openFile(sc: ShortcutConfig & { type: 'file' }): Promise<void> {
    const base = this.currentTree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) return;
    const filePath = path.isAbsolute(sc.path) ? sc.path : path.join(base, sc.path);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
  }

  private handleTerminalClose(terminal: vscode.Terminal): void {
    for (const [name, managed] of this.terminals) {
      if (managed !== terminal) continue;
      this.terminals.delete(name);
      this._onDidChange.fire();
      const sc = this.config.shortcuts.find(s => s.type === 'terminal' && s.name === name);
      if (sc && sc.type === 'terminal' && sc.command) {
        vscode.window.showWarningMessage(`Terminal "${name}" exited. Restart?`, 'Restart', 'Ignore')
          .then(c => { if (c === 'Restart') this.open(sc); });
      }
      break;
    }
  }

  private resolvePorts(value: string): string {
    if (!this.currentTree) return value;
    return resolvePortVars(value, this.config.ports.mapping, this.currentTree.portBase);
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
    this.disposables.forEach(d => d.dispose());
  }
}
