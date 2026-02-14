import { exec, commandExists } from '../utils/exec';

let _available: boolean | null = null;

export async function isAvailable(): Promise<boolean> {
  if (_available === null) _available = await commandExists('gh');
  return _available;
}

export async function mergePR(
  worktreePath: string,
  opts?: { squash?: boolean; deleteBranch?: boolean },
): Promise<void> {
  const flags: string[] = [];
  if (opts?.squash !== false) flags.push('--squash');
  if (opts?.deleteBranch !== false) flags.push('--delete-branch');
  await exec('gh', ['pr', 'merge', ...flags], { cwd: worktreePath, timeout: 30_000 });
}

export async function prStatus(worktreePath: string): Promise<{ state: string; reviewDecision: string | null } | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'state,reviewDecision'], { cwd: worktreePath, timeout: 10_000 });
    const data = JSON.parse(stdout);
    return { state: data.state || 'OPEN', reviewDecision: data.reviewDecision || null };
  } catch { return null; }
}

export async function prIsMerged(repoPath: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'state'], { cwd: repoPath, timeout: 10_000 });
    return JSON.parse(stdout).state === 'MERGED';
  } catch { return false; }
}

export async function createPR(worktreePath: string, baseBranch: string, title: string): Promise<string | null> {
  const base = baseBranch.replace(/^origin\//, '');
  const { stdout } = await exec('gh', ['pr', 'create', '--base', base, '--title', title, '--fill', '--json', 'url', '--jq', '.url'], { cwd: worktreePath, timeout: 30_000 });
  return stdout || null;
}

export async function getPRUrl(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: worktreePath, timeout: 10_000 });
    return stdout || null;
  } catch { return null; }
}
