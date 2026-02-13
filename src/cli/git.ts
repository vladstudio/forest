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
  await exec('git', ['branch', '-D', branch], { cwd: repoPath }).catch(() => {});
  await exec('git', ['push', 'origin', '--delete', branch], { cwd: repoPath }).catch(() => {});
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await exec('git', ['push', '-u', 'origin', branch], { cwd: worktreePath });
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
  return stdout.length > 0;
}
