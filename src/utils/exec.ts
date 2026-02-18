import { execFile as cpExecFile, exec as cpExec, spawn } from 'child_process';
import { promisify } from 'util';
import { log } from '../logger';

const execFileAsync = promisify(cpExecFile);
const execAsync = promisify(cpExec);

export interface ExecResult { stdout: string; stderr: string; }

/** Safe exec using execFile (no shell). Use for CLI tools with known arguments. */
export async function exec(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  try {
    const r = await execFileAsync(command, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (e: any) {
    log.error(`exec failed: ${command} ${args.join(' ')} — ${e.message}`);
    throw e;
  }
}

/** Shell exec for user-defined commands that need shell interpretation. */
export async function execShell(
  command: string,
  opts?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  try {
    const r = await execAsync(command, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (e: any) {
    log.error(`execShell failed: ${command} — ${e.message}`);
    throw e;
  }
}

/** Shell exec with real-time output streaming via onData callback. */
export function execStream(
  command: string,
  opts?: { cwd?: string; timeout?: number; onData?: (chunk: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: opts?.cwd });
    let stdout = '';
    let stderr = '';
    const timer = opts?.timeout ? setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, opts.timeout) : undefined;
    child.stdout?.on('data', (data: Buffer) => {
      const s = data.toString();
      stdout += s;
      opts?.onData?.(s);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const s = data.toString();
      stderr += s;
      opts?.onData?.(s);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`Command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });
}

export async function commandExists(name: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try { await exec(cmd, [name]); return true; } catch { return false; }
}
