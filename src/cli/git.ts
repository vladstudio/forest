import { exec } from '../utils/exec';

export async function createWorktree(
  repoPath: string, worktreePath: string, branch: string, baseRef: string,
): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: repoPath });
  await exec('git', ['worktree', 'prune'], { cwd: repoPath });
  await exec('git', ['worktree', 'add', worktreePath, '-b', branch, baseRef], { cwd: repoPath });
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await exec('git', ['branch', '-D', branch], { cwd: repoPath });
  await exec('git', ['push', 'origin', '--delete', branch], { cwd: repoPath }).catch(() => {});
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await exec('git', ['push', '-u', 'origin', branch], { cwd: worktreePath });
}

export async function pullMerge(worktreePath: string, baseRef: string): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: worktreePath });
  await exec('git', ['merge', baseRef], { cwd: worktreePath, timeout: 60_000 });
}

export async function pullRebase(worktreePath: string, baseRef: string): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: worktreePath });
  await exec('git', ['rebase', baseRef], { cwd: worktreePath, timeout: 60_000 });
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
  return stdout.length > 0;
}

export async function commitsBehind(worktreePath: string, baseRef: string): Promise<number> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `HEAD..${baseRef}`], { cwd: worktreePath, timeout: 10_000 });
    return parseInt(stdout) || 0;
  } catch { return 0; }
}

export async function commitsAhead(worktreePath: string, baseRef: string): Promise<number> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `${baseRef}..HEAD`], { cwd: worktreePath, timeout: 10_000 });
    return parseInt(stdout) || 0;
  } catch { return 0; }
}

export async function lastCommitAge(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['log', '-1', '--format=%cr'], { cwd: worktreePath, timeout: 5_000 });
    return stdout || 'unknown';
  } catch { return 'unknown'; }
}

/** Check out an existing branch into a new worktree (no -b flag).
 *  Caller should fetch first (e.g. listBranches already does).
 *  If the branch is checked out in the main repo, detaches HEAD first. */
export async function checkoutWorktree(
  repoPath: string, worktreePath: string, branch: string,
): Promise<void> {
  // If branch is checked out in main repo, detach so worktree add can use it
  const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
  if (stdout.trim() === branch) {
    await exec('git', ['checkout', '--detach'], { cwd: repoPath });
  }
  await exec('git', ['worktree', 'prune'], { cwd: repoPath });
  await exec('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath });
}

/** List local branches suitable for worktree checkout, excluding base branch and those already in worktrees. */
export async function listBranches(repoPath: string, baseBranch: string): Promise<string[]> {
  await exec('git', ['fetch', 'origin'], { cwd: repoPath });

  // Get branches checked out in non-main worktrees (main repo's branch is okay — we'll detach it)
  const { stdout: wtOut } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
  const wtBranches = new Set<string>();
  let wtIndex = 0; // first entry (index 0) is always the main worktree
  for (const line of wtOut.split('\n')) {
    if (line.startsWith('worktree ')) { wtIndex++; continue; }
    if (wtIndex > 1 && line.startsWith('branch ')) wtBranches.add(line.replace('branch refs/heads/', ''));
  }

  // Local branches
  const { stdout: localOut } = await exec('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath });
  const allBranches = new Set(localOut.split('\n').map(b => b.trim()).filter(Boolean));

  // Remote branches active in last 7 days, not already local
  const cutoff = Math.floor((Date.now() - 7 * 86_400_000) / 1000);
  const { stdout: remoteOut } = await exec('git', [
    'for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/remotes/origin/',
  ], { cwd: repoPath });
  for (const line of remoteOut.split('\n').filter(Boolean)) {
    const [ref, ts] = line.split(' ');
    if (ref === 'origin/HEAD') continue;
    const name = ref.replace('origin/', '');
    if (!allBranches.has(name) && parseInt(ts) >= cutoff) allBranches.add(name);
  }

  // Strip "origin/" from baseBranch for comparison
  const base = baseBranch.replace(/^origin\//, '');
  return [...allBranches]
    .filter(b => b !== base && !wtBranches.has(b))
    .sort();
}