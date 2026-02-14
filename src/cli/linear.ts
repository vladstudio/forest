import { exec, commandExists } from '../utils/exec';

export interface LinearIssue {
  id: string;
  title: string;
  state: string;
  priority: number;
  url?: string;
}

let _available: boolean | null = null;

export async function isAvailable(): Promise<boolean> {
  if (_available === null) _available = await commandExists('linear');
  return _available;
}

/**
 * List issues assigned to current user.
 * Parses table output since `linear issue list` has no --json flag.
 */
export async function listMyIssues(
  states: string[],
  team?: string,
): Promise<LinearIssue[]> {
  try {
    const args = ['issue', 'list', ...states.flatMap(s => ['-s', s]), '--sort', 'priority', '--no-pager'];
    if (team) args.push('--team', team);
    const { stdout } = await exec(
      'linear', args,
      { timeout: 15_000 },
    );
    return parseIssueTable(stdout);
  } catch { return []; }
}

/** Parse `linear issue list` table output into structured data. */
function parseIssueTable(output: string): LinearIssue[] {
  const issues: LinearIssue[] = [];
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const line of clean.split('\n')) {
    const match = line.match(/([A-Z]+-\d+)\s+(.+)/);
    if (!match) continue;
    const id = match[1];
    const rest = match[2];
    // State is the word before the "N timeunit ago" timestamp at end of line
    const stateMatch = rest.match(/(\S+)\s+\d+\s+\w+\s+ago\s*$/);
    const state = stateMatch?.[1] || 'Unknown';
    // Title is everything up to the first run of 2+ spaces
    const title = rest.match(/^(.+?)  /)?.[1]?.trim() || rest.trim();
    issues.push({ id, title, state, priority: 3 });
  }
  return issues;
}

export async function getIssue(issueId: string): Promise<LinearIssue | null> {
  try {
    const { stdout } = await exec(
      'linear', ['issue', 'view', issueId, '--json', '--no-pager', '--no-download'],
      { timeout: 10_000 },
    );
    const data = JSON.parse(stdout);
    if (!data?.id || !data?.title) return null;
    return { id: data.id, title: data.title, state: data.state ?? 'Unknown', priority: data.priority ?? 3 };
  } catch { return null; }
}

export async function createIssue(opts: {
  title: string;
  priority?: number;
  label?: string;
  team?: string;
}): Promise<string> {
  const args = ['issue', 'create', '-t', opts.title, '-a', 'self', '--start', '--no-interactive'];
  if (opts.priority) args.push('--priority', String(opts.priority));
  if (opts.label) args.push('-l', opts.label);
  if (opts.team) args.push('--team', opts.team);
  const { stdout } = await exec('linear', args, { timeout: 15_000 });
  const match = stdout.match(/([A-Z]+-\d+)/);
  if (!match) throw new Error(`Could not parse ticket ID from: ${stdout}`);
  return match[1];
}

export async function updateIssueState(issueId: string, state: string): Promise<void> {
  await exec('linear', ['issue', 'update', issueId, '-s', state], { timeout: 10_000 });
}

export async function createPR(issueId: string, baseBranch: string, cwd?: string): Promise<string | null> {
  try {
    const base = baseBranch.replace(/^origin\//, '');
    const { stdout } = await exec(
      'linear', ['issue', 'pr', issueId, '--base', base],
      { cwd, timeout: 30_000 },
    );
    const urlMatch = stdout.match(/(https:\/\/github\.com\/[^\s]+)/);
    return urlMatch ? urlMatch[1] : null;
  } catch (err) {
    throw new Error(`Failed to create PR: ${err}`);
  }
}

export async function getIssueUrl(issueId: string): Promise<string | null> {
  try {
    const { stdout } = await exec('linear', ['issue', 'url', issueId], { timeout: 5_000 });
    return stdout || null;
  } catch { return null; }
}
