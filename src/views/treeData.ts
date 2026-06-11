import * as fs from 'fs';
import * as path from 'path';
import type { ForestConfig } from '../config';
import { getHostWorkspacePath } from '../context';
import * as gh from '../cli/gh';
import * as git from '../cli/git';
import type { StateManager, TreeState } from '../state';

export interface TreeCardData {
  key: string;
  branch: string;
  ticketId?: string;
  ticketTitle?: string;
  prNumber?: number;
  prState?: string;
  prUrl?: string;
  hasRemoteBranch?: boolean;
  behind: number;
  ahead: number;
  remoteBehind: number;
  hasTrackingRef: boolean;
  localChanges: { added: number; removed: number; modified: number } | null;
  isCurrent: boolean;
  cleaning: boolean;
  busyOperation?: string;
  loading?: boolean;
  stale?: boolean;
  error?: string;
  fetchedAt?: number;
}

export interface WebviewData {
  repoName: string;
  baseBranch: string;
  mainIsCurrent: boolean;
  mainBehind: number;
  hasAI: boolean;
  hasAutomerge: boolean;
  linearEnabled: boolean;
  groups: Array<{ label: string; trees: TreeCardData[] }>;
}

export function treeKey(t: Pick<TreeState, 'repoPath' | 'branch'>): string {
  return JSON.stringify({ repoPath: t.repoPath, branch: t.branch });
}

export function parseTreeKey(key: string): Pick<TreeState, 'repoPath' | 'branch'> | undefined {
  try {
    const value = JSON.parse(key);
    return typeof value?.repoPath === 'string' && typeof value?.branch === 'string' ? value : undefined;
  } catch { return undefined; }
}

function baseCard(t: TreeState, isCurrent: boolean): TreeCardData {
  return {
    key: treeKey(t),
    branch: t.branch,
    ticketId: t.ticketId, ticketTitle: t.title,
    behind: 0, ahead: 0, remoteBehind: 0, hasTrackingRef: false, localChanges: null,
    isCurrent, cleaning: false, busyOperation: t.busyOperation,
  };
}

function carryDerivedData(next: TreeCardData, previous: TreeCardData): TreeCardData {
  return {
    ...next,
    prNumber: previous.prNumber,
    prState: previous.prState,
    prUrl: previous.prUrl,
    hasRemoteBranch: previous.hasRemoteBranch,
    behind: previous.behind,
    ahead: previous.ahead,
    remoteBehind: previous.remoteBehind,
    hasTrackingRef: previous.hasTrackingRef,
    localChanges: previous.localChanges,
    loading: previous.loading,
    stale: previous.stale,
    error: previous.error,
    fetchedAt: previous.fetchedAt,
  };
}

interface SnapshotEntry {
  card: TreeCardData;
  fetchPromise?: Promise<void>;
  fetchedAt?: number;
}

interface Disposable { dispose(): void }
type Event<T> = (listener: (event: T) => unknown) => Disposable;

class SimpleEventEmitter<T> implements Disposable {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class TreeDataService implements Disposable {
  private cache = new Map<string, SnapshotEntry>();
  private readonly ttl = 60_000;
  private readonly onDidChangeSnapshotsEmitter = new SimpleEventEmitter<{ repoPath: string; keys?: string[] }>();
  readonly onDidChangeSnapshots = this.onDidChangeSnapshotsEmitter.event;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshRunning = false;

  constructor(
    private stateManager: StateManager,
    private config: ForestConfig,
    private repoPath: () => string,
    private log: (msg: string) => void,
  ) {}

  startAutoRefresh(ms = 60_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.refreshRunning) return;
      this.refreshRunning = true;
      this.refreshRepo(this.repoPath(), { force: true })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          this.log(`Tree data refresh failed: ${message}`);
        })
        .finally(() => { this.refreshRunning = false; });
    }, ms);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.onDidChangeSnapshotsEmitter.dispose();
  }

  getSnapshot(key: string): TreeCardData | undefined {
    return this.cache.get(key)?.card;
  }

  markTreeStale(repoPath: string, branch: string): void {
    const entry = this.cache.get(treeKey({ repoPath, branch }));
    if (entry) entry.card = { ...entry.card, stale: true };
  }

  async refreshTree(repoPath: string, branch: string, opts?: { force?: boolean }): Promise<void> {
    const state = await this.stateManager.load();
    const tree = this.stateManager.getTree(state, repoPath, branch);
    if (!tree) return;
    await this.refreshSnapshot(tree, opts);
  }

  async refreshRepo(repoPath = this.repoPath(), opts?: { force?: boolean }): Promise<void> {
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const liveKeys = new Set(trees.map(treeKey));
    for (const key of this.cache.keys()) if (!liveKeys.has(key)) this.cache.delete(key);
    await Promise.all(trees.filter(t => !t.cleaning).map(t => this.refreshSnapshot(t, opts)));
  }

  async build(): Promise<WebviewData> {
    const repoPath = this.repoPath();
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const curPath = getHostWorkspacePath();
    const liveKeys = new Set(trees.map(treeKey));
    for (const k of this.cache.keys()) if (!liveKeys.has(k)) this.cache.delete(k);

    trees.sort((a, b) => {
      if (a.path === curPath) return -1;
      if (b.path === curPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const mainIsCurrent = curPath === repoPath;
    const [cards, mainBehind] = await Promise.all([
      Promise.all(trees.map(t => t.cleaning ? Promise.resolve(null) : this.cardForBuild(t).catch(() => null))),
      mainIsCurrent ? git.commitsBehindRemote(repoPath, this.config.baseBranch) : Promise.resolve(0),
    ]);
    const groups = new Map<string, TreeCardData[]>();
    const add = (label: string, card: TreeCardData) => groups.set(label, [...(groups.get(label) ?? []), card]);

    trees.forEach((t, i) => {
      const isCurrent = t.path === curPath;
      if (t.cleaning) return add('Deleting', { ...baseCard(t, isCurrent), cleaning: true });
      const cached = cards[i];
      if (!cached) return;
      const card = { ...cached, isCurrent, busyOperation: t.busyOperation };
      if (card.prState === 'MERGED') add('Done', card);
      else if (card.prState === 'CLOSED') add('Closed', card);
      else if (card.prNumber) add('In review', card);
      else add('In progress', card);
    });

    return {
      repoName: path.basename(repoPath),
      baseBranch: this.config.baseBranch,
      mainIsCurrent,
      mainBehind,
      hasAI: !!this.config.tetra,
      hasAutomerge: this.config.github.enabled && (gh.repoHasAutomergeCached(repoPath) ?? false),
      linearEnabled: this.config.linear.enabled,
      groups: ['In progress', 'In review', 'Done', 'Closed', 'Deleting'].flatMap(label => {
        const trees = groups.get(label);
        return trees?.length ? [{ label, trees }] : [];
      }),
    };
  }

  private async cardForBuild(tree: TreeState): Promise<TreeCardData> {
    const entry = this.getOrStartRefresh(tree);
    if (!entry.fetchedAt && entry.fetchPromise) await entry.fetchPromise;
    return entry.card;
  }

  private async refreshSnapshot(tree: TreeState, opts?: { force?: boolean }): Promise<TreeCardData> {
    const entry = this.getOrStartRefresh(tree, opts);
    if (entry.fetchPromise) await entry.fetchPromise;
    return entry.card;
  }

  private getOrStartRefresh(tree: TreeState, opts?: { force?: boolean }): SnapshotEntry {
    const key = treeKey(tree);
    const now = Date.now();
    let entry = this.cache.get(key);
    const isCurrent = entry?.card.isCurrent ?? false;
    if (!entry) {
      entry = { card: baseCard(tree, isCurrent) };
      this.cache.set(key, entry);
    } else {
      entry.card = carryDerivedData(baseCard(tree, entry.card.isCurrent), entry.card);
    }

    const fresh = entry.fetchedAt && now - entry.fetchedAt < this.ttl;
    if (!opts?.force && fresh) return entry;
    if (!entry.fetchPromise) {
      entry.card = { ...entry.card, loading: true, stale: !!entry.fetchedAt, error: undefined };
      entry.fetchPromise = this.fetch(tree)
        .then(card => {
          entry!.fetchedAt = Date.now();
          entry!.card = { ...card, fetchedAt: entry!.fetchedAt, loading: false, stale: false, error: undefined };
          this.onDidChangeSnapshotsEmitter.fire({ repoPath: tree.repoPath, keys: [key] });
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          entry!.card = { ...entry!.card, loading: false, stale: true, error: message };
          this.log(`Tree data fetch failed: ${message}`);
          this.onDidChangeSnapshotsEmitter.fire({ repoPath: tree.repoPath, keys: [key] });
        })
        .finally(() => { entry!.fetchPromise = undefined; });
    }
    return entry;
  }

  private async fetch(tree: TreeState): Promise<TreeCardData> {
    const base = baseCard(tree, false);
    if (!tree.path || !fs.existsSync(tree.path)) return base;
    const [behind, ahead, remoteBehind, pr, localChanges, hasRemoteBranch] = await Promise.all([
      git.commitsBehindRemote(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, tree.branch),
      git.commitsBehindRemote(tree.path, tree.branch),
      this.config.github.enabled ? gh.prStatus(tree.path) : Promise.resolve(null),
      git.localChanges(tree.path),
      git.remoteBranchExists(tree.repoPath, tree.branch).catch(() => false),
    ]);
    if (pr?.url && !tree.prUrl) {
      this.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: pr.url }).catch((e) => this.log(`PR URL save failed: ${e.message}`));
    }
    return { ...base, prNumber: pr?.number, prState: pr?.state, prUrl: pr?.url, hasRemoteBranch, behind, ahead: ahead.count, hasTrackingRef: ahead.hasTrackingRef, remoteBehind, localChanges };
  }
}
