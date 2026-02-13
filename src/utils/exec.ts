import { execFile as cpExecFile, exec as cpExec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(cpExecFile);
const execAsync = promisify(cpExec);

export interface ExecResult { stdout: string; stderr: string; }

/** Safe exec using execFile (no shell). Use for CLI tools with known arguments. */
export async function exec(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  const r = await execFileAsync(command, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** Shell exec for user-defined commands that need shell interpretation. */
export async function execShell(
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
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try { await exec(cmd, [name]); return true; } catch { return false; }
}
