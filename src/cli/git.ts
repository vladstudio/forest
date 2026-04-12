import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from '../utils/exec';
import { shortBaseBranch } from '../utils/slug';
import { log } from '../logger';

const stashRef = (ref: number | string) => typeof ref === 'number' ? `stash@{${ref}}` : ref;

export async function createWorktree(
  repoPath: string, worktreePath: string, branch: string, baseRef: string,
): Promise<void> {
  log.info(`createWorktree: ${branch} at ${worktreePath} (base: ${baseRef})`);
  await Promise.all([
    exec('git', ['fetch', 'origin', shortBaseBranch(baseRef)], { cwd: repoPath }),
    exec('git', ['worktree', 'prune'], { cwd: repoPath }),
  ]);
  await exec('git', ['-c', 'checkout.workers=0', 'worktree', 'add', worktreePath, '-b', branch, baseRef], { cwd: repoPath });
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  log.info(`removeWorktree: ${worktreePath}`);
  // Safety: refuse to delete the parent trees directory
  const treesRoot = path.join(os.homedir(), '.forest', 'trees');
  const rel = path.relative(treesRoot, worktreePath);
  if (!rel || rel.startsWith('..') || rel.split(path.sep).length < 2) {
    log.error(`removeWorktree: refusing dangerous path: ${worktreePath}`);
    throw new Error(`removeWorktree: refusing dangerous path: ${worktreePath}`);
  }
  try {
    await exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
  } catch {
    // Not registered — prune stale metadata
    await exec('git', ['worktree', 'prune'], { cwd: repoPath }).catch(() => {});
  }
  // Always remove the directory — git worktree remove leaves gitignored files behind
  await fs.promises.rm(worktreePath, { recursive: true, force: true });
}

export async function deleteBranch(repoPath: string, branch: string, opts?: { skipRemote?: boolean }): Promise<void> {
  log.info(`deleteBranch: ${branch}`);
  await exec('git', ['branch', '-D', branch], { cwd: repoPath });
  if (!opts?.skipRemote) {
    await exec('git', ['push', 'origin', '--delete', branch], { cwd: repoPath }).catch((e: any) => {
      log.warn(`deleteBranch remote delete failed for ${branch}: ${e.message}`);
    });
  }
}

export async function pushBranch(worktreePath: string, branch: string, opts?: { signal?: AbortSignal }): Promise<void> {
  log.info(`pushBranch: ${branch}`);
  await exec('git', ['push', '-u', 'origin', branch], { cwd: worktreePath, signal: opts?.signal });
}

export async function pull(worktreePath: string, opts?: { signal?: AbortSignal }): Promise<void> {
  log.info(`pull: ${worktreePath}`);
  await exec('git', ['pull'], { cwd: worktreePath, timeout: 60_000, signal: opts?.signal });
}

export async function pullMerge(worktreePath: string, baseRef: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: worktreePath, signal: opts?.signal });
  await exec('git', ['merge', baseRef], { cwd: worktreePath, timeout: 60_000, signal: opts?.signal });
}

export async function pullRebase(worktreePath: string, baseRef: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: worktreePath, signal: opts?.signal });
  await exec('git', ['rebase', baseRef], { cwd: worktreePath, timeout: 60_000, signal: opts?.signal });
}

export async function stash(repoPath: string, message: string): Promise<string> {
  await exec('git', ['stash', 'push', '-u', '-m', message], { cwd: repoPath });
  const { stdout } = await exec('git', ['stash', 'list', '--format=%gd%x00%gs'], { cwd: repoPath });
  const ref = stdout.split('\n').map(line => line.split('\0')).find(([, m]) => m?.replace(/^On [^:]+:\s*/, '') === message)?.[0];
  if (!ref) throw new Error('Could not find created stash');
  return ref;
}

export async function stashApply(repoPath: string, ref: number | string): Promise<void> {
  await exec('git', ['stash', 'apply', stashRef(ref)], { cwd: repoPath });
}

export async function stashDrop(repoPath: string, ref: number | string): Promise<void> {
  await exec('git', ['stash', 'drop', stashRef(ref)], { cwd: repoPath });
}

export async function discardChanges(repoPath: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await exec('git', ['reset', '--hard', 'HEAD'], { cwd: repoPath, signal: opts?.signal });
  await exec('git', ['clean', '-fd'], { cwd: repoPath, signal: opts?.signal });
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
  return stdout.trim().length > 0;
}

export async function localChanges(worktreePath: string): Promise<{ added: number; removed: number; modified: number } | null> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
    if (!stdout.trim()) return null;
    let added = 0, removed = 0, modified = 0;
    for (const line of stdout.split('\n').filter(Boolean)) {
      if (line.length < 2) continue;
      const x = line[0], y = line[1];
      if (x === '?' && y === '?') { added++; continue; }
      if (x === '!' && y === '!') continue;
      if (x === 'D' || y === 'D') { removed++; continue; }
      if (x === 'A') { added++; continue; }
      modified++;
    }
    return { added, removed, modified };
  } catch { return null; }
}

export const commitsAhead = (wt: string, branch: string) =>
  revListCount(wt, `origin/${branch}..HEAD`);

export async function commitAll(worktreePath: string, message: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: worktreePath, signal: opts?.signal });
  await exec('git', ['commit', '-m', message], { cwd: worktreePath, signal: opts?.signal });
}

export async function discardUnstaged(worktreePath: string, opts?: { signal?: AbortSignal }): Promise<void> {
  await exec('git', ['checkout', '--', '.'], { cwd: worktreePath, signal: opts?.signal });
}

export async function workingDiff(worktreePath: string): Promise<string> {
  const { stdout } = await exec('git', ['diff', 'HEAD'], { cwd: worktreePath, timeout: 30_000 });
  return stdout;
}

async function revListCount(worktreePath: string, range: string): Promise<number> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', range], { cwd: worktreePath, timeout: 10_000 });
    return parseInt(stdout) || 0;
  } catch { return 0; }
}

export const commitsBehind = (wt: string, base: string) => revListCount(wt, `HEAD..${base}`);

export async function diffFromBase(worktreePath: string, baseRef: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const { stdout } = await exec('git', ['diff', baseRef + '...HEAD'], { cwd: worktreePath, timeout: 30_000, signal: opts?.signal });
  return stdout;
}

export interface DiffFileChange {
  status: string;
  path: string;
  originalPath?: string;
}

export async function diffFilesFromBase(
  worktreePath: string,
  baseRef: string,
): Promise<{ mergeBase: string; changes: DiffFileChange[] }> {
  const { stdout: mergeBaseStdout } = await exec('git', ['merge-base', baseRef, 'HEAD'], { cwd: worktreePath, timeout: 10_000 });
  const mergeBase = mergeBaseStdout.trim();
  if (!mergeBase) throw new Error(`Could not resolve merge base for ${baseRef}`);

  const changes = await diffFilesBetweenRefs(worktreePath, mergeBase, 'HEAD');
  return { mergeBase, changes };
}

export async function diffFilesBetweenRefs(
  worktreePath: string,
  leftRef: string,
  rightRef: string,
): Promise<DiffFileChange[]> {
  const { stdout } = await exec('git', ['diff', '--name-status', '-M', leftRef, rightRef], { cwd: worktreePath, timeout: 30_000 });
  const changes = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0]?.[0] ?? '';
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { status, originalPath: parts[1], path: parts[2] };
      }
      if (parts.length >= 2) {
        return { status, path: parts[1] };
      }
      return null;
    })
    .filter((change): change is DiffFileChange => !!change && !!change.status && !!change.path);
  return changes;
}

export async function lastCommitAge(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['log', '-1', '--format=%cr'], { cwd: worktreePath, timeout: 5_000 });
    return stdout || null;
  } catch { return null; }
}

/** Check out an existing branch into a new worktree (no -b flag).
 *  Caller should fetch first (e.g. listBranches already does).
 *  If the branch is checked out in the main repo, detaches HEAD first. */
export async function checkoutWorktree(
  repoPath: string, worktreePath: string, branch: string,
): Promise<void> {
  // Fetch, check current branch, and prune in parallel
  const [, { stdout }] = await Promise.all([
    exec('git', ['fetch', 'origin', branch], { cwd: repoPath }).catch(() => {}),
    exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
    exec('git', ['worktree', 'prune'], { cwd: repoPath }),
  ]);
  // If branch is checked out in main repo, detach so worktree add can use it
  if (stdout.trim() === branch) {
    await exec('git', ['checkout', '--detach'], { cwd: repoPath });
  }
  await exec('git', ['-c', 'checkout.workers=0', 'worktree', 'add', worktreePath, branch], { cwd: repoPath });
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const { stdout } = await exec('git', ['ls-remote', '--heads', 'origin', branch], { cwd: repoPath });
  return stdout.trim().length > 0;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  await exec('git', ['fetch', 'origin', branch], { cwd: repoPath }).catch(() => {});
  const { stdout } = await exec('git', ['for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], { cwd: repoPath });
  return stdout.trim().length > 0;
}

/** List local branches suitable for worktree checkout, excluding base branch and those already in worktrees. */
export async function listBranches(repoPath: string, baseBranch: string, opts?: { signal?: AbortSignal }): Promise<string[]> {
  await exec('git', ['fetch', 'origin'], { cwd: repoPath, signal: opts?.signal });

  const [{ stdout: wtOut }, { stdout: localOut }, { stdout: remoteOut }] = await Promise.all([
    exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath }),
    exec('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath }),
    exec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'], { cwd: repoPath }),
  ]);

  // Get branches checked out in non-main worktrees (main repo's branch is okay — we'll detach it)
  const wtBranches = new Set<string>();
  let wtIndex = 0; // first entry (index 0) is always the main worktree
  for (const line of wtOut.split('\n')) {
    if (line.startsWith('worktree ')) { wtIndex++; continue; }
    if (wtIndex > 1 && line.startsWith('branch ')) wtBranches.add(line.replace('branch refs/heads/', ''));
  }

  // Local branches
  const allBranches = new Set(localOut.split('\n').map(b => b.trim()).filter(Boolean));
  for (const line of remoteOut.split('\n').filter(Boolean)) {
    if (line === 'origin/HEAD') continue;
    const name = line.replace('origin/', '');
    if (!allBranches.has(name)) allBranches.add(name);
  }

  const base = shortBaseBranch(baseBranch);
  return [...allBranches]
    .filter(b => b !== base && !wtBranches.has(b))
    .sort();
}
