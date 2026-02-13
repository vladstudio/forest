import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TerminalConfig {
  name: string;
  command?: string;
  autostart: boolean;
  env?: Record<string, string>;
}

export interface BrowserConfig {
  name: string;
  url: string;
  waitForPort?: boolean;
  waitTimeout?: number;
}

export interface ForestConfig {
  version: number;
  treesDir: string;
  copy: string[];
  setup: string | string[];
  terminals: TerminalConfig[];
  browsers: BrowserConfig[];
  ports: { baseRange: [number, number]; mapping: Record<string, string> };
  env: Record<string, string>;
  integrations: { linear: boolean; github: boolean };
  branchFormat: string;
  baseBranch: string;
  maxTrees: number;
}

const DEFAULTS: Partial<ForestConfig> = {
  copy: [],
  terminals: [],
  browsers: [],
  env: {},
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

  // Resolve ~ in treesDir
  if (merged.treesDir) {
    merged.treesDir = merged.treesDir.replace(/^~/, os.homedir());
    const repoName = path.basename(ws.uri.fsPath);
    merged.treesDir = merged.treesDir.replace('${repo}', repoName);
  }

  return merged as ForestConfig;
}

function mergeConfig(base: any, local: any): any {
  const result = { ...base };
  for (const key of Object.keys(local)) {
    if (key === 'terminals' && Array.isArray(local[key])) {
      // Merge terminals by name
      const baseTerminals = [...(base.terminals || [])];
      for (const lt of local[key]) {
        const idx = baseTerminals.findIndex((t: any) => t.name === lt.name);
        if (idx >= 0) baseTerminals[idx] = { ...baseTerminals[idx], ...lt };
        else baseTerminals.push(lt);
      }
      result.terminals = baseTerminals;
    } else if (typeof local[key] === 'object' && !Array.isArray(local[key]) && local[key] !== null) {
      result[key] = { ...(base[key] || {}), ...local[key] };
    } else {
      result[key] = local[key];
    }
  }
  return result;
}
