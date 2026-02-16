import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMainRepo } from './context';

interface ShortcutBase { name: string; openOnLaunch?: number | false; mode?: 'single-repo' | 'single-tree' | 'multiple'; }
interface TerminalShortcut extends ShortcutBase { type: 'terminal'; command?: string; env?: Record<string, string>; }
interface BrowserShortcut extends ShortcutBase { type: 'browser'; url: string; }
interface FileShortcut extends ShortcutBase { type: 'file'; path: string; }
export type ShortcutConfig = TerminalShortcut | BrowserShortcut | FileShortcut;

export interface ForestConfig {
  version: number;
  copy: string[];
  setup: string | string[];
  shortcuts: ShortcutConfig[];
  linear: { enabled: boolean; apiKey?: string; teams?: string[]; statuses: { issueList: string[]; onNew: string; onShip: string; onCleanup: string; onCancel: string } };
  github: { enabled: boolean };
  branchFormat: string;
  baseBranch: string;
  maxTrees: number;
}

const DEFAULTS: Partial<ForestConfig> = {
  copy: [],
  shortcuts: [],
  linear: { enabled: false, statuses: { issueList: ['triage', 'backlog', 'unstarted'], onNew: 'started', onShip: 'in review', onCleanup: 'completed', onCancel: 'canceled' } },
  github: { enabled: true },
  branchFormat: '${ticketId}-${slug}',
  baseBranch: 'origin/main',
  maxTrees: 10,
};

export async function loadConfig(): Promise<ForestConfig | null> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return null;

  const repoRoot = resolveMainRepo(ws.uri.fsPath);
  const configPath = path.join(repoRoot, '.forest', 'config.json');
  if (!fs.existsSync(configPath)) return null;

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    vscode.window.showErrorMessage(`Forest config is invalid: ${e}`);
    return null;
  }

  // Merge: defaults → config → local
  let merged: any = mergeConfig(DEFAULTS, config);
  const localPath = path.join(repoRoot, '.forest', 'local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      merged = mergeConfig(merged, local);
    } catch {
      vscode.window.showWarningMessage('Forest: local.json has syntax errors, ignoring overrides.');
    }
  }

  // Auto-enable Linear when API key is present
  if (merged.linear?.apiKey) {
    merged.linear.enabled = true;
  }

  return merged as ForestConfig;
}

/** Returns ~/.forest/trees/<repoName>. */
export function getTreesDir(repoPath: string): string {
  return path.join(os.homedir(), '.forest', 'trees', path.basename(repoPath));
}

function mergeConfig(base: any, local: any): any {
  const result = { ...base };
  for (const key of Object.keys(local)) {
    if (key === 'shortcuts' && Array.isArray(local[key])) {
      // Merge named arrays by name
      const baseArr = [...(base[key] || [])];
      for (const item of local[key]) {
        const idx = baseArr.findIndex((b: any) => b.name === item.name);
        if (idx >= 0) baseArr[idx] = { ...baseArr[idx], ...item };
        else baseArr.push(item);
      }
      result[key] = baseArr;
    } else if (typeof local[key] === 'object' && !Array.isArray(local[key]) && local[key] !== null) {
      result[key] = mergeConfig(base[key] || {}, local[key]);
    } else {
      result[key] = local[key];
    }
  }
  return result;
}
