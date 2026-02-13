import { exec as cpExec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(cpExec);

export interface ExecResult { stdout: string; stderr: string; }

export async function exec(
  command: string,
  opts?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  const r = await execAsync(command, {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

export async function commandExists(name: string): Promise<boolean> {
  try { await exec(`which ${name}`); return true; } catch { return false; }
}
