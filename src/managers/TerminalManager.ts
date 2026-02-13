import * as vscode from 'vscode';
import type { ForestConfig, TerminalConfig } from '../config';
import type { TreeState } from '../state';
import { resolvePortVars } from '../utils/ports';

export class TerminalManager {
  private managed = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor(private config: ForestConfig, private currentTree: TreeState | undefined) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(t => this.handleClose(t)),
    );
  }

  async ensureConfiguredTerminals(): Promise<void> {
    if (!this.currentTree) return;
    const existing = new Set(vscode.window.terminals.map(t => t.name));
    for (const tc of this.config.terminals) {
      const name = `[Forest] ${tc.name}`;
      if (existing.has(name)) {
        const t = vscode.window.terminals.find(t => t.name === name);
        if (t) this.managed.set(tc.name, t);
        continue;
      }
      this.create(tc);
    }
  }

  private create(tc: TerminalConfig): vscode.Terminal {
    const env: Record<string, string> = { ...tc.env };
    if (this.currentTree && this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        env[k] = this.resolvePorts(v);
      }
    }
    const terminal = vscode.window.createTerminal({
      name: `[Forest] ${tc.name}`,
      cwd: this.currentTree?.path,
      env,
    });
    if (tc.autostart && tc.command) terminal.sendText(tc.command);
    this.managed.set(tc.name, terminal);
    return terminal;
  }

  private handleClose(terminal: vscode.Terminal): void {
    for (const [name, managed] of this.managed) {
      if (managed === terminal) {
        this.managed.delete(name);
        const tc = this.config.terminals.find(t => t.name === name);
        if (tc?.autostart) {
          vscode.window.showWarningMessage(`Terminal "${name}" exited. Restart?`, 'Restart', 'Ignore')
            .then(c => { if (c === 'Restart') this.create(tc); });
        }
        break;
      }
    }
  }

  private resolvePorts(value: string): string {
    if (!this.currentTree) return value;
    return resolvePortVars(value, this.config.ports.mapping, this.currentTree.portBase);
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }
}
