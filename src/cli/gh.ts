import * as vscode from 'vscode';
import { exec, commandExists } from '../utils/exec';

let _available: boolean | null = null;
let _authWarned = false;

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

export async function prStatus(worktreePath: string): Promise<{ state: string; reviewDecision: string | null; number?: number } | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'state,reviewDecision,number'], { cwd: worktreePath, timeout: 10_000 });
    const data = JSON.parse(stdout);
    return { state: data.state || 'OPEN', reviewDecision: data.reviewDecision || null, number: data.number };
  } catch (e: any) {
    if (!_authWarned && (e.stderr || e.message || '').includes('auth login')) {
      _authWarned = true;
      vscode.window.showWarningMessage('Forest: GitHub CLI auth expired. Run "gh auth login" in your terminal.');
    }
    return null;
  }
}

export async function prIsMerged(repoPath: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'state'], { cwd: repoPath, timeout: 10_000 });
    return JSON.parse(stdout).state === 'MERGED';
  } catch { return false; }
}

export async function createPR(worktreePath: string, baseBranch: string, title: string): Promise<string | null> {
  const base = baseBranch.replace(/^origin\//, '');
  const { stdout } = await exec('gh', ['pr', 'create', '--base', base, '--title', title, '--fill'], { cwd: worktreePath, timeout: 30_000 });
  // gh pr create prints the URL on the last line (may have preamble text)
  const url = stdout.trim().split('\n').pop()?.trim();
  return url || null;
}
