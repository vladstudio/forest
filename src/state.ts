import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export interface TreeState {
  ticketId: string;
  title: string;
  branch: string;
  path: string;
  repoPath: string;
  portBase: number;
  createdAt: string;
  prUrl?: string;
}

export interface ForestState {
  version: number;
  trees: Record<string, TreeState>;
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
    this.watcher = fs.watch(this.statePath, () => {
      try {
        const content = fs.readFileSync(this.statePath, 'utf8');
        if (content !== lastContent) {
          lastContent = content;
          this._onDidChange.fire(JSON.parse(content));
        }
      } catch {}
    });
  }

  async load(): Promise<ForestState> {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      const empty: ForestState = { version: 1, trees: {} };
      await this.save(empty);
      return empty;
    }
  }

  loadSync(): ForestState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return { version: 1, trees: {} };
    }
  }

  async save(state: ForestState): Promise<void> {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  private key(repoPath: string, ticketId: string): string {
    return `${repoPath}:${ticketId}`;
  }

  private async serialize(fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise(r => (release = r));
    await prev;
    try { await fn(); } finally { release(); }
  }

  async addTree(repoPath: string, tree: TreeState): Promise<void> {
    await this.serialize(async () => {
      const state = await this.load();
      state.trees[this.key(repoPath, tree.ticketId)] = tree;
      await this.save(state);
    });
  }

  async removeTree(repoPath: string, ticketId: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.load();
      delete state.trees[this.key(repoPath, ticketId)];
      await this.save(state);
    });
  }

  async updateTree(repoPath: string, ticketId: string, updates: Partial<TreeState>): Promise<void> {
    await this.serialize(async () => {
      const state = await this.load();
      const k = this.key(repoPath, ticketId);
      if (state.trees[k]) {
        state.trees[k] = { ...state.trees[k], ...updates };
        await this.save(state);
      }
    });
  }

  getTreesForRepo(state: ForestState, repoPath: string): TreeState[] {
    return Object.values(state.trees).filter(t => t.repoPath === repoPath);
  }

  getTree(state: ForestState, repoPath: string, ticketId: string): TreeState | undefined {
    return state.trees[this.key(repoPath, ticketId)];
  }

  dispose(): void {
    this.watcher?.close();
    this._onDidChange.dispose();
  }
}
