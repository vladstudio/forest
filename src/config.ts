import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMainRepo } from './context';

interface ShortcutBase { name: string; openOnLaunch?: number | false; allowMultiple?: boolean; }
interface TerminalShortcut extends ShortcutBase { type: 'terminal'; command?: string; env?: Record<string, string>; }
interface BrowserShortcut extends ShortcutBase { type: 'browser'; url: string; }
interface FileShortcut extends ShortcutBase { type: 'file'; path: string; }
export type ShortcutConfig = TerminalShortcut | BrowserShortcut | FileShortcut;

export interface ForestConfig {
  version: number;
  copy: string[];
  setup: string | string[];
  shortcuts: ShortcutConfig[];
  ports: { baseRange: [number, number]; mapping: Record<string, string> };
  env: Record<string, string>;
  linear: { enabled: boolean; apiKey?: string; team?: string; statuses: { issueList: string[]; onNew: string; onShip: string; onCleanup: string; onCancel: string } };
  github: { enabled: boolean };
  branchFormat: string;
  baseBranch: string;
  maxTrees: number;
}

const DEFAULTS: Partial<ForestConfig> = {
  copy: [],
  shortcuts: [],
  env: {},
  ports: { baseRange: [3000, 4000], mapping: {} },
  linear: { enabled: false, statuses: { issueList: ['triage', 'backlog', 'unstarted'], onNew: 'started', onShip: 'in review', onCleanup: 'completed', onCancel: 'canceled' } },
  github: { enabled: true },
  branchFormat: '${ticketId}-${slug}',
  baseBranch: 'origin/main',
  maxTrees: 10,
};

/** Migrate old `integrations` + `linearStatuses` → `linear` + `github`. Mutates in place. */
function migrateConfig(config: any): void {
  if (config.integrations) {
    const { linear: linearEnabled, github: githubEnabled, linearTeam } = config.integrations;
    if (!config.linear) config.linear = {};
    if (linearEnabled !== undefined) config.linear.enabled = linearEnabled;
    if (linearTeam !== undefined) config.linear.team = linearTeam;
    if (!config.github) config.github = {};
    if (githubEnabled !== undefined) config.github.enabled = githubEnabled;
    delete config.integrations;
  }
  if (config.linearStatuses) {
    if (!config.linear) config.linear = {};
    config.linear.statuses = config.linearStatuses;
    delete config.linearStatuses;
  }
}

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

  // Migrate v1 config shape
  migrateConfig(config);

  // Merge: defaults → config → local
  let merged: any = mergeConfig(DEFAULTS, config);
  const localPath = path.join(repoRoot, '.forest', 'local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      migrateConfig(local);
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
