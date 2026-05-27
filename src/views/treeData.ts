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
  behind: number;
  ahead: number;
  remoteBehind: number;
  hasTrackingRef: boolean;
  localChanges: { added: number; removed: number; modified: number } | null;
  isCurrent: boolean;
  cleaning: boolean;
  busyOperation?: string;
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

export class TreeDataService {
  private cache = new Map<string, { data: Promise<TreeCardData>; time: number }>();
  private readonly ttl = 30_000;

  constructor(
    private stateManager: StateManager,
    private config: ForestConfig,
    private repoPath: () => string,
    private log: (msg: string) => void,
  ) {}

  clear(): void { this.cache.clear(); }

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
      Promise.all(trees.map(t => t.cleaning ? Promise.resolve(null) : this.get(t).catch(() => null))),
      mainIsCurrent ? git.commitsBehind(repoPath, this.config.baseBranch) : Promise.resolve(0),
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
      hasAI: !!this.config.ai,
      hasAutomerge: this.config.github.enabled && (gh.repoHasAutomergeCached(repoPath) ?? false),
      linearEnabled: this.config.linear.enabled,
      groups: ['In progress', 'In review', 'Done', 'Closed', 'Deleting'].flatMap(label => {
        const trees = groups.get(label);
        return trees?.length ? [{ label, trees }] : [];
      }),
    };
  }

  private get(tree: TreeState): Promise<TreeCardData> {
    const key = treeKey(tree);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < this.ttl) return cached.data;
    const data = this.fetch(tree);
    this.cache.set(key, { data, time: Date.now() });
    data.catch((e) => {
      this.cache.delete(key);
      this.log(`Tree data fetch failed: ${e.message}`);
    });
    return data;
  }

  private async fetch(tree: TreeState): Promise<TreeCardData> {
    const base = baseCard(tree, false);
    if (!tree.path || !fs.existsSync(tree.path)) return base;
    const [behind, ahead, remoteBehind, pr, localChanges, hasTrackingRef] = await Promise.all([
      git.commitsBehind(tree.path, this.config.baseBranch),
      git.commitsAhead(tree.path, tree.branch),
      git.commitsBehindRemote(tree.path, tree.branch),
      this.config.github.enabled ? gh.prStatus(tree.path) : Promise.resolve(null),
      git.localChanges(tree.path),
      git.trackingRefExists(tree.path, tree.branch),
    ]);
    if (pr?.url && !tree.prUrl) {
      this.stateManager.updateTree(tree.repoPath, tree.branch, { prUrl: pr.url }).catch((e) => this.log(`PR URL save failed: ${e.message}`));
    }
    return { ...base, prNumber: pr?.number, prState: pr?.state, behind, ahead, remoteBehind, hasTrackingRef, localChanges };
  }
}
