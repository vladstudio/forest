import { execFile as cpExecFile, exec as cpExec } from 'child_process';
import { promisify } from 'util';
import { log } from '../logger';

const execFileAsync = promisify(cpExecFile);
const execAsync = promisify(cpExec);

interface ExecResult { stdout: string; stderr: string; }

/** Safe exec using execFile (no shell). Use for CLI tools with known arguments. */
export async function exec(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  try {
    const r = await execFileAsync(command, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: opts?.signal,
    });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (e: any) {
    if (e.name === 'AbortError') log.info(`exec aborted: ${command} ${args.join(' ')}`);
    else log.error(`exec failed: ${command} ${args.join(' ')} — ${e.message}`);
    throw e;
  }
}

/** Shell exec for user-defined commands that need shell interpretation. */
export async function execShell(
  command: string,
  opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  try {
    const r = await execAsync(command, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: opts?.signal,
    });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (e: any) {
    if (e.name === 'AbortError') log.info(`execShell aborted: ${command}`);
    else log.error(`execShell failed: ${command} — ${e.message}`);
    throw e;
  }
}

export async function commandExists(name: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try { await exec(cmd, [name]); return true; } catch { return false; }
}
