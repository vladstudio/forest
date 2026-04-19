import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { repoHash } from './utils/fs';
import { resolveMainRepo } from './utils/repo';
import { notify } from './notify';

interface ShortcutBase { name: string; onNewTree?: boolean; }
interface TerminalShortcut extends ShortcutBase { type: 'terminal'; command?: string; env?: Record<string, string>; }
interface BrowserShortcut extends ShortcutBase { type: 'browser'; url: string; browser?: 'integrated' | 'external' | string; }
interface FileShortcut extends ShortcutBase { type: 'file'; path: string; }
export type ShortcutConfig = TerminalShortcut | BrowserShortcut | FileShortcut;

interface RawShortcut {
  name: string;
  type?: 'terminal' | 'browser' | 'file';
  command?: string;
  url?: string;
  path?: string;
  onNewTree?: boolean;
  env?: Record<string, string>;
  browser?: string;
}

/** Infer shortcut type from fields when not explicitly set. */
function normalizeShortcut(raw: RawShortcut): ShortcutConfig {
  const { type, ...rest } = raw;
  if (type === 'browser' && raw.url) return { type: 'browser', url: raw.url, ...rest } as BrowserShortcut;
  if (type === 'file' && raw.path) return { type: 'file', path: raw.path, ...rest } as FileShortcut;
  if (type === 'terminal') return { type: 'terminal', ...rest } as TerminalShortcut;
  if (raw.url) return { type: 'browser', url: raw.url, ...rest } as BrowserShortcut;
  if (raw.path) return { type: 'file', path: raw.path, ...rest } as FileShortcut;
  return { type: 'terminal', ...rest } as TerminalShortcut;
}

export interface AIConfig {
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  apiKey: string;
}

export interface ForestConfig {
  version: number;
  copy: string[];
  shortcuts: ShortcutConfig[];
  linear: { enabled: boolean; apiKey?: string; teams?: string[]; statuses: { issueList: string[]; onNew: string; onShip: string; onCleanup: string; onCancel: string } };
  github: { enabled: boolean };
  ai?: AIConfig;
  branchFormat: string;
  baseBranch: string;
  maxTrees: number;
  browser: string[];
  terminal: string[];
}

const DEFAULTS: Partial<ForestConfig> = {
  copy: [],
  shortcuts: [],
  linear: { enabled: false, statuses: { issueList: ['triage', 'backlog', 'unstarted', 'started'], onNew: 'started', onShip: 'in review', onCleanup: 'completed', onCancel: 'canceled' } },
  github: { enabled: true },
  branchFormat: '${ticketId}-${slug}',
  baseBranch: 'main',
  maxTrees: 10,
  browser: ['integrated'],
  terminal: ['integrated'],
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
    notify.error(`Forest config is invalid: ${e}`);
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
      notify.warn('Forest: local.json has syntax errors, ignoring overrides.');
    }
  }

  // Auto-enable Linear when API key is present or teams are configured
  if (merged.linear?.apiKey || merged.linear?.teams?.length) {
    merged.linear.enabled = true;
  }

  // Normalize browser/terminal to arrays
  if (typeof merged.browser === 'string') merged.browser = [merged.browser];
  if (typeof merged.terminal === 'string') merged.terminal = [merged.terminal];

  // Normalize shortcuts: infer type from fields
  if (Array.isArray(merged.shortcuts)) {
    merged.shortcuts = merged.shortcuts.map(normalizeShortcut);
  }

  // Normalize baseBranch: strip any origin/ prefix — callers prepend when needed
  merged.baseBranch = (merged.baseBranch?.trim() || 'main').replace(/^origin\//, '');

  // Normalize github: accept boolean shorthand
  if (typeof merged.github === 'boolean') {
    merged.github = { enabled: merged.github };
  }

  // Validate required fields
  if (!merged.baseBranch || typeof merged.baseBranch !== 'string') {
    notify.error('Forest config: "baseBranch" is required and must be a string.');
    return null;
  }
  if (!Array.isArray(merged.shortcuts)) {
    notify.error('Forest config: "shortcuts" must be an array.');
    return null;
  }

  return merged as ForestConfig;
}

/** Returns ~/.forest/trees/<repoName>[-<hash>]. Uses old unhashed dir if it exists for backwards compat. */
const treesDirCache = new Map<string, string>();
export function getTreesDir(repoPath: string): string {
  let dir = treesDirCache.get(repoPath);
  if (dir) return dir;
  const base = path.basename(repoPath);
  const oldDir = path.join(os.homedir(), '.forest', 'trees', base);
  dir = fs.existsSync(oldDir) ? oldDir
    : path.join(os.homedir(), '.forest', 'trees', `${base}-${repoHash(repoPath)}`);
  treesDirCache.set(repoPath, dir);
  return dir;
}

function mergeConfig<T extends Record<string, any>>(base: T, local: Partial<T>): T {
  const result = { ...base } as Record<string, any>;
  for (const key of Object.keys(local)) {
    const localVal = local[key as keyof T];
    if (localVal === null) continue;

    if (key === 'shortcuts' && Array.isArray(localVal)) {
      // Merge named arrays by name
      const baseArr = [...(result[key] || [])];
      for (const item of localVal as any[]) {
        const idx = baseArr.findIndex((b: any) => b.name === item.name);
        if (idx >= 0) baseArr[idx] = { ...baseArr[idx], ...item };
        else baseArr.push(item);
      }
      result[key] = baseArr;
    } else if (typeof localVal === 'object' && !Array.isArray(localVal)) {
      result[key] = mergeConfig(result[key] || {}, localVal);
    } else {
      result[key] = localVal;
    }
  }
  return result as T;
}
