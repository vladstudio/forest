const MAX_DIFF_CHARS = 100_000;
const MAX_DIFF_CHARS_COMMIT = 10_000;
const TETRA_PORT = 24100;

export async function generatePRBody(diff: string, title: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const trimmedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated]'
    : diff;

  return callTetra('AI Generate PR description', trimmedDiff, { title }, opts?.signal);
}

export async function generateCommitMessage(diff: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const trimmed = diff.length > MAX_DIFF_CHARS_COMMIT
    ? diff.slice(0, MAX_DIFF_CHARS_COMMIT) + '\n[diff truncated]'
    : diff;

  return callTetra('AI Generate commit message', trimmed, undefined, opts?.signal);
}

async function callTetra(command: string, text: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const res = await fetch(`http://localhost:${TETRA_PORT}/transform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, text, args }),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!res.ok) {
    throw new Error(`Tetra API error: ${res.status}. Make sure Tetra is running on port ${TETRA_PORT}.`);
  }
  const data = await res.json() as { result: string };
  return data.result?.trim() ?? '';
}
