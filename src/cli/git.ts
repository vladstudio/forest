import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../utils/exec';

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
}

export async function createWorktree(
  repoPath: string, worktreePath: string, branch: string, baseRef: string,
): Promise<void> {
  await exec('git fetch origin', { cwd: repoPath });
  await exec(`git worktree add "${worktreePath}" -b "${branch}" "${baseRef}"`, { cwd: repoPath });
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await exec(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath });
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const { stdout } = await exec('git worktree list --porcelain', { cwd: repoPath });
  const worktrees: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) cur.path = line.slice(9);
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch refs/heads/'.length);
    else if (line === '' && cur.path && cur.head) {
      worktrees.push({ path: cur.path, head: cur.head, branch: cur.branch ?? null });
      cur = {};
    }
  }
  return worktrees;
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await exec(`git branch -D "${branch}"`, { cwd: repoPath }).catch(() => {});
  await exec(`git push origin --delete "${branch}"`, { cwd: repoPath }).catch(() => {});
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await exec(`git push -u origin "${branch}"`, { cwd: worktreePath });
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await exec('git status --porcelain', { cwd: worktreePath });
  return stdout.length > 0;
}

export function getMainRepoPath(worktreePath: string): string | null {
  const gitPath = path.join(worktreePath, '.git');
  try {
    if (fs.statSync(gitPath).isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const gitdir = content.replace('gitdir: ', '');
      return path.resolve(gitdir, '..', '..', '..');
    }
  } catch {}
  return null;
}
