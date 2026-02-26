import * as vscode from 'vscode';
import { exec, commandExists } from '../utils/exec';
import { log } from '../logger';

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
  try {
    await exec('gh', ['pr', 'merge', ...flags], { cwd: worktreePath, timeout: 30_000 });
  } catch (e: any) {
    if (/already merged/i.test(e.stderr || e.message || '')) return;
    throw e;
  }
}

export async function prStatus(worktreePath: string): Promise<{ state: string; reviewDecision: string | null; number?: number; url?: string } | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'state,reviewDecision,number,url'], { cwd: worktreePath, timeout: 10_000 });
    const data = JSON.parse(stdout);
    return { state: data.state || 'OPEN', reviewDecision: data.reviewDecision || null, number: data.number, url: data.url };
  } catch (e: any) {
    log.error(`prStatus failed: ${e.message}`);
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
  } catch (e: any) { log.error(`prIsMerged(${branch}) failed: ${e.message}`); return false; }
}

let automergeCache: boolean | undefined;
export async function repoHasAutomerge(worktreePath: string): Promise<boolean> {
  if (automergeCache !== undefined) return automergeCache;
  try {
    const { stdout } = await exec('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'], { cwd: worktreePath, timeout: 10_000 });
    return (automergeCache = stdout.trim() === 'true');
  } catch (e: any) {
    log.error(`repoHasAutomerge check failed: ${e.message}`);
    return false;
  }
}

export async function enableAutomerge(worktreePath: string): Promise<void> {
  await exec('gh', ['pr', 'merge', '--auto', '--squash'], { cwd: worktreePath, timeout: 30_000 });
}

export async function createPR(worktreePath: string, baseBranch: string, title: string, body?: string): Promise<string | null> {
  log.info(`createPR: "${title}" → ${baseBranch}`);
  const base = baseBranch.replace(/^origin\//, '');
  const args = ['pr', 'create', '--base', base, '--title', title];
  if (body) {
    args.push('--body', body);
  } else {
    args.push('--fill');
  }
  const { stdout } = await exec('gh', args, { cwd: worktreePath, timeout: 30_000 });
  // gh pr create prints the URL on the last line (may have preamble text)
  const url = stdout.trim().split('\n').pop()?.trim();
  log.info(`createPR result: ${url ?? '(no url)'}`);
  return url || null;
}
