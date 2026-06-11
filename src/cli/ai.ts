import type { TetraConfig } from '../config';

const MAX_DIFF_CHARS = 100_000;
const MAX_DIFF_CHARS_COMMIT = 10_000;

export async function generatePRBody(tetra: TetraConfig, diff: string, title: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const trimmedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated]'
    : diff;

  return callTetra(tetra, tetra.commands.pr, trimmedDiff, { title }, opts?.signal);
}

export async function generateCommitMessage(tetra: TetraConfig, diff: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const trimmed = diff.length > MAX_DIFF_CHARS_COMMIT
    ? diff.slice(0, MAX_DIFF_CHARS_COMMIT) + '\n[diff truncated]'
    : diff;

  return callTetra(tetra, tetra.commands.commit, trimmed, undefined, opts?.signal);
}

async function callTetra(tetra: TetraConfig, command: string, text: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const res = await fetch(`http://localhost:${tetra.port}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, text, args }),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!res.ok) {
    throw new Error(`Tetra API error: ${res.status}. Make sure Tetra is running on port ${tetra.port}.`);
  }
  const data = await res.json() as { result: string };
  return data.result?.trim() ?? '';
}

/** Lightweight reachability check for the Tetra server. Used at activation
 *  to warn the user when `tetra` is configured but Tetra isn't running —
 *  without this, marketplace users would see silent fallbacks with no
 *  indication. Any HTTP response (even 404) means the server is up; fetch
 *  only throws on connection errors. We don't check `res.ok` because Tetra
 *  returns 404 for unknown routes including `GET /` — the real endpoint is
 *  `POST /transform`. */
export async function isAvailable(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(1_500),
    });
    return true;
  } catch {
    return false;
  }
}
