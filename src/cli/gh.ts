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
  await exec(`gh pr merge ${flags.join(' ')}`, { cwd: worktreePath, timeout: 30_000 });
}

export async function getPRUrl(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('gh pr view --json url --jq .url', { cwd: worktreePath, timeout: 10_000 });
    return stdout || null;
  } catch { return null; }
}
