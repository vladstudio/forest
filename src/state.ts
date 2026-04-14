import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { notify } from './notify';

export interface TreeState {
  branch: string;
  repoPath: string;
  createdAt: string;
  path?: string;
  ticketId?: string;
  title?: string;
  prUrl?: string;
  mergeNotified?: boolean;
  cleaning?: boolean;
  busyOperation?: string;
  busyHeartbeatAt?: string;
  needsSetup?: boolean;
}

export const TREE_OPERATION_HEARTBEAT_MS = 15_000;
export const TREE_OPERATION_STALE_MS = 45_000;

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
  private _onDidChange = new vscode.EventEmitter<{ state: ForestState; isLocal: boolean }>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: fs.FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private writeLock = Promise.resolve();
  private lastWrittenContent = '';

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
    try { lastContent = fs.readFileSync(this.statePath, 'utf8'); } catch { }
    const dir = path.dirname(this.statePath);
    const basename = path.basename(this.statePath);
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== basename) return;
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        try {
          const content = fs.readFileSync(this.statePath, 'utf8');
          if (content !== lastContent) {
            lastContent = content;
            if (content === this.lastWrittenContent) return; // self-write
            this._onDidChange.fire({ state: JSON.parse(content), isLocal: false });
          }
        } catch { }
      }, 50);
    });
  }

  async load(): Promise<ForestState> {
    try { return JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')) as ForestState; } catch (e: any) {
      if (e.code === 'ENOENT') {
        const empty: ForestState = { version: 1, trees: {} };
        await this.save(empty);
        return empty;
      }
      const backup = `${this.statePath}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.statePath, backup); } catch { }
      notify.error('Forest state is unreadable. Starting empty; original kept as a .corrupt backup.');
      return { version: 1, trees: {} };
    }
  }

  loadSync(): ForestState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ForestState;
    } catch {
      return { version: 1, trees: {} };
    }
  }

  private async save(state: ForestState): Promise<void> {
    const data = JSON.stringify(state, null, 2);
    this.lastWrittenContent = data;
    const tmp = this.statePath + '.tmp';
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, this.statePath);
  }

  private key(repoPath: string, branch: string): string {
    return `${repoPath}:${branch}`;
  }

  /** Cross-process file lock using mkdir (atomic on all platforms). */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = this.statePath + '.lock';
    for (let i = 0;; i++) {
      try { fs.mkdirSync(lock); } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock); continue; } } catch {}
        if (i >= 99) throw new Error('State file is locked');
        await new Promise(r => setTimeout(r, 50)); continue;
      }
      try { return await fn(); } finally { try { fs.rmSync(lock); } catch {} }
    }
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
        this._onDidChange.fire({ state, isLocal: true });
      });
    } finally { release(); }
  }

  async addTree(repoPath: string, tree: TreeState): Promise<void> {
    await this.modify(state => { state.trees[this.key(repoPath, tree.branch)] = tree; });
  }

  async removeTree(repoPath: string, branch: string): Promise<void> {
    await this.modify(state => { delete state.trees[this.key(repoPath, branch)]; });
  }

  async updateTree(repoPath: string, branch: string, updates: Partial<TreeState>): Promise<void> {
    await this.modify(state => {
      const k = this.key(repoPath, branch);
      if (state.trees[k]) state.trees[k] = { ...state.trees[k], ...updates };
    });
  }

  private isTreeOperationStale(tree: TreeState, now: number): boolean {
    if (!tree.busyOperation) return false;
    const heartbeat = tree.busyHeartbeatAt ? Date.parse(tree.busyHeartbeatAt) : NaN;
    if (!Number.isFinite(heartbeat)) return true;
    return now - heartbeat > TREE_OPERATION_STALE_MS;
  }

  async tryStartTreeOperation(repoPath: string, branch: string, busyOperation: string): Promise<{ started: boolean; active?: string }> {
    let started = false;
    let active: string | undefined;
    const now = Date.now();
    const heartbeatAt = new Date(now).toISOString();
    await this.modify(state => {
      const k = this.key(repoPath, branch);
      const tree = state.trees[k];
      if (!tree) return;
      if (tree.cleaning) {
        active = 'cleaning up';
        return;
      }
      if (tree.busyOperation && !this.isTreeOperationStale(tree, now)) {
        active = tree.busyOperation;
        return;
      }
      state.trees[k] = { ...tree, busyOperation, busyHeartbeatAt: heartbeatAt };
      started = true;
    });
    return { started, active };
  }

  async touchTreeOperation(repoPath: string, branch: string, busyOperation?: string): Promise<void> {
    const heartbeatAt = new Date().toISOString();
    await this.modify(state => {
      const k = this.key(repoPath, branch);
      const tree = state.trees[k];
      if (!tree?.busyOperation) return;
      if (busyOperation && tree.busyOperation !== busyOperation) return;
      state.trees[k] = { ...tree, busyHeartbeatAt: heartbeatAt };
    });
  }

  async clearTreeOperation(repoPath: string, branch: string, busyOperation?: string): Promise<void> {
    await this.modify(state => {
      const k = this.key(repoPath, branch);
      const tree = state.trees[k];
      if (!tree?.busyOperation) return;
      if (busyOperation && tree.busyOperation !== busyOperation) return;
      state.trees[k] = { ...tree, busyOperation: undefined, busyHeartbeatAt: undefined };
    });
  }

  async clearStaleTreeOperations(repoPath?: string): Promise<Array<{ branch: string; busyOperation: string }>> {
    const cleared: Array<{ branch: string; busyOperation: string }> = [];
    const now = Date.now();
    await this.modify(state => {
      for (const tree of Object.values(state.trees)) {
        if (repoPath && tree.repoPath !== repoPath) continue;
        if (!tree.busyOperation || !this.isTreeOperationStale(tree, now)) continue;
        cleared.push({ branch: tree.branch, busyOperation: tree.busyOperation });
        tree.busyOperation = undefined;
        tree.busyHeartbeatAt = undefined;
      }
    });
    return cleared;
  }

  getTreesForRepo(state: ForestState, repoPath: string): TreeState[] {
    return Object.values(state.trees).filter(t => t.repoPath === repoPath);
  }

  getTree(state: ForestState, repoPath: string, branch: string): TreeState | undefined {
    return state.trees[this.key(repoPath, branch)];
  }

  dispose(): void {
    clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this._onDidChange.dispose();
  }
}
