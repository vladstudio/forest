import { exec } from '../utils/exec';

export async function createWorktree(
  repoPath: string, worktreePath: string, branch: string, baseRef: string,
): Promise<void> {
  await exec('git', ['fetch', 'origin'], { cwd: repoPath });
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