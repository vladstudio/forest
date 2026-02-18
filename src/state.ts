import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { log } from './logger';

export interface TreeState {
  branch: string;
  repoPath: string;
  createdAt: string;
  path?: string;
  ticketId?: string;
  title?: string;
  prUrl?: string;
  mergeNotified?: boolean;
}

export interface ForestState {
  version: 1;
  trees: Record<string, TreeState>;
}

/** Display name: "TICKET-ID  title" if ticket, else branch name. */
export function displayName(tree: TreeState): string {
  if (tree.ticketId && tree.title) return `${tree.ticketId}  ${tree.title}`;
  if (tree.title && tree.title !== tree.branch) return tree.title;
  return tree.branch;
}

export class StateManager {
  private statePath: string;
  private _onDidChange = new vscode.EventEmitter<ForestState>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: fs.FSWatcher;
  private writeLock = Promise.resolve();

  constructor() {
    this.statePath = path.join(os.homedir(), '.forest', 'state.json');
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.statePath)) await this.save({ version: 1, trees: {} });
    this.startWatching();
  }

  private startWatching(): void {
    let lastContent = '';
    try { lastContent = fs.readFileSync(this.statePath, 'utf8'); } catch {}
    const dir = path.dirname(this.statePath);
    const basename = path.basename(this.statePath);
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== basename) return;
      try {
        const content = fs.readFileSync(this.statePath, 'utf8');
        if (content !== lastContent) {
          lastContent = content;
          log.info('State file changed externally');
          this._onDidChange.fire(JSON.parse(content));
        }
      } catch (e: any) { log.error(`State watch read failed: ${e.message}`); }
    });
  }

  async load(): Promise<ForestState> {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ForestState;
    } catch {
      const empty: ForestState = { version: 1, trees: {} };
      await this.save(empty);
      return empty;
    }
  }

  loadSync(): ForestState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ForestState;
    } catch {
      return { version: 1, trees: {} };
    }
  }

  async save(state: ForestState): Promise<void> {
    const keys = Object.keys(state.trees);
    log.info(`State save: ${keys.length} trees [${keys.join(', ')}]`);
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  private key(repoPath: string, branch: string): string {
    return `${repoPath}:${branch}`;
  }

  /** In-process queue + cross-process file lock around read-modify-write. */
  private async modify(fn: (state: ForestState) => void): Promise<void> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise(r => (release = r));
    await prev;
    try {
      await this.withFileLock(async () => {
        const state = await this.load();
        fn(state);
        await this.save(state);
      });
    } finally { release(); }
  }

  private get lockPath() { return this.statePath + '.lock'; }

  private async withFileLock(fn: () => Promise<void>): Promise<void> {
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(this.lockPath); break; } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 10_000) {
            log.warn('Removing stale state lock');
            fs.rmdirSync(this.lockPath); continue;
          }
        } catch {}
        if (i >= 29) { log.error('Could not acquire state lock after 30 retries'); throw new Error('Could not acquire state lock'); }
        if (i > 0 && i % 10 === 0) log.warn(`State lock contention: retry ${i}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }
    try { await fn(); } finally { try { fs.rmdirSync(this.lockPath); } catch {} }
  }

  async addTree(repoPath: string, tree: TreeState): Promise<void> {
    log.info(`addTree: ${tree.branch} (${tree.ticketId ?? 'no ticket'})`);
    await this.modify(state => { state.trees[this.key(repoPath, tree.branch)] = tree; });
  }

  async removeTree(repoPath: string, branch: string): Promise<void> {
    log.info(`removeTree: ${branch}`);
    await this.modify(state => { delete state.trees[this.key(repoPath, branch)]; });
  }

  async updateTree(repoPath: string, branch: string, updates: Partial<TreeState>): Promise<void> {
    log.info(`updateTree: ${branch} ${JSON.stringify(updates)}`);
    await this.modify(state => {
      const k = this.key(repoPath, branch);
      if (state.trees[k]) state.trees[k] = { ...state.trees[k], ...updates };
      else log.warn(`updateTree: key ${k} not found in state`);
    });
  }

  getTreesForRepo(state: ForestState, repoPath: string): TreeState[] {
    return Object.values(state.trees).filter(t => t.repoPath === repoPath);
  }

  getTree(state: ForestState, repoPath: string, branch: string): TreeState | undefined {
    return state.trees[this.key(repoPath, branch)];
  }

  dispose(): void {
    this.watcher?.close();
    this._onDidChange.dispose();
  }
}
