import * as vscode from 'vscode';
import type { ForestConfig } from '../config';
import type { TreeState } from '../state';
import { isPortOpen, resolvePortVars } from '../utils/ports';

export class BrowserManager {
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private config: ForestConfig, private currentTree: TreeState | undefined) {}

  async openConfiguredBrowsers(): Promise<void> {
    if (!this.currentTree || !this.config.browsers?.length) return;
    for (const bc of this.config.browsers) {
      const url = this.resolveUrl(bc.url);
      if (bc.waitForPort) {
        const port = this.extractPort(url);
        if (port) this.waitAndOpen(port, url, (bc.waitTimeout ?? 120) * 1000);
      } else {
        this.openBrowser(url);
      }
    }
  }

  private async waitAndOpen(port: number, url: string, timeout: number): Promise<void> {
    const start = Date.now();
    const check = async (): Promise<void> => {
      if (Date.now() - start > timeout) {
        const c = await vscode.window.showWarningMessage(`Timed out waiting for port ${port}.`, 'Open Anyway');
        if (c) this.openBrowser(url);
        return;
      }
      if (await isPortOpen(port)) { this.openBrowser(url); return; }
      const timer = setTimeout(() => { this.pendingTimers.delete(timer); check(); }, 2000);
      this.pendingTimers.add(timer);
    };
    check();
  }

  private async openBrowser(url: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), {
        viewColumn: vscode.ViewColumn.Beside, preserveFocus: true,
      });
    } catch {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private resolveUrl(url: string): string {
    if (!this.currentTree) return url;
    return resolvePortVars(url, this.config.ports.mapping, this.currentTree.portBase);
  }

  private extractPort(url: string): number | null {
    const m = url.match(/:(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  dispose(): void {
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.pendingTimers.clear();
  }
}
