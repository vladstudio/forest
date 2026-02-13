import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ShortcutBase { name: string; openOnLaunch?: number | false; }
interface TerminalShortcut extends ShortcutBase { type: 'terminal'; command?: string; env?: Record<string, string>; }
interface BrowserShortcut extends ShortcutBase { type: 'browser'; url: string; }
interface FileShortcut extends ShortcutBase { type: 'file'; path: string; }
export type ShortcutConfig = TerminalShortcut | BrowserShortcut | FileShortcut;

export interface ForestConfig {
  version: number;
  treesDir: string;
  copy: string[];
  setup: string | string[];
  shortcuts: ShortcutConfig[];
  ports: { baseRange: [number, number]; mapping: Record<string, string> };
  env: Record<string, string>;
  integrations: { linear: boolean; github: boolean; linearTeam?: string };
  branchFormat: string;
  baseBranch: string;
  maxTrees: number;
}

const DEFAULTS: Partial<ForestConfig> = {
  copy: [],
  shortcuts: [],
  env: {},
  ports: { baseRange: [3000, 4000], mapping: {} },
  integrations: { linear: true, github: true },
  branchFormat: '${ticketId}-${slug}',
  baseBranch: 'origin/main',
  maxTrees: 10,
};

export async function loadConfig(): Promise<ForestConfig | null> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return null;

  const configPath = path.join(ws.uri.fsPath, '.forest', 'config.json');
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
  const localPath = path.join(ws.uri.fsPath, '.forest', 'local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      merged = mergeConfig(merged, local);
    } catch {
      vscode.window.showWarningMessage('Forest: local.json has syntax errors, ignoring overrides.');
    }
  }

  if (!merged.treesDir) {
    vscode.window.showErrorMessage('Forest: "treesDir" is required in .forest/config.json');
    return null;
  }

  // Resolve ~ in treesDir
  merged.treesDir = merged.treesDir.replace(/^~/, os.homedir());
  const repoName = path.basename(ws.uri.fsPath);
  merged.treesDir = merged.treesDir.replace('${repo}', repoName);

  return merged as ForestConfig;
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
      result[key] = { ...(base[key] || {}), ...local[key] };
    } else {
      result[key] = local[key];
    }
  }
  return result;
}
