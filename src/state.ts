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
  status: 'dev' | 'testing' | 'review' | 'done';
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
    fs.watch(this.statePath, () => {
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

  async addTree(repoPath: string, tree: TreeState): Promise<void> {
    const state = await this.load();
    state.trees[this.key(repoPath, tree.ticketId)] = tree;
    await this.save(state);
  }

  async removeTree(repoPath: string, ticketId: string): Promise<void> {
    const state = await this.load();
    delete state.trees[this.key(repoPath, ticketId)];
    await this.save(state);
  }

  async updateTree(repoPath: string, ticketId: string, updates: Partial<TreeState>): Promise<void> {
    const state = await this.load();
    const k = this.key(repoPath, ticketId);
    if (state.trees[k]) {
      state.trees[k] = { ...state.trees[k], ...updates };
      await this.save(state);
    }
  }

  getTreesForRepo(state: ForestState, repoPath: string): TreeState[] {
    return Object.values(state.trees).filter(t => t.repoPath === repoPath);
  }

  getTree(state: ForestState, repoPath: string, ticketId: string): TreeState | undefined {
    return state.trees[this.key(repoPath, ticketId)];
  }
}
