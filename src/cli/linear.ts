const API = 'https://api.linear.app/graphql';

let _apiKey: string | undefined;

export function configure(apiKey?: string): void {
  _apiKey = apiKey;
}

export function isAvailable(): boolean {
  return !!_apiKey;
}

export interface LinearIssue {
  id: string;
  title: string;
  state: string;
  priority: number;
  url?: string;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!_apiKey) throw new Error('Linear API key not configured');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: _apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${res.statusText}`);
  const json = await res.json() as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

// Cache workflow states per team to avoid repeated lookups
const stateCache = new Map<string, { id: string; name: string; type: string }[]>();

async function getWorkflowStates(teamKey: string): Promise<{ id: string; name: string; type: string }[]> {
  const cached = stateCache.get(teamKey);
  if (cached) return cached;
  const data = await gql<{ workflowStates: { nodes: { id: string; name: string; type: string }[] } }>(
    `query($teamKey: String!) {
      workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
        nodes { id name type }
      }
    }`,
    { teamKey },
  );
  const states = data.workflowStates.nodes;
  stateCache.set(teamKey, states);
  return states;
}

/** Resolve a state name (custom like "In Review") or type (like "started") to a state ID. */
async function resolveStateId(teamKey: string, nameOrType: string): Promise<string> {
  const states = await getWorkflowStates(teamKey);
  const lower = nameOrType.toLowerCase();
  // Try exact name match first (case-insensitive)
  const byName = states.find(s => s.name.toLowerCase() === lower);
  if (byName) return byName.id;
  // Fall back to type match
  const byType = states.find(s => s.type === lower);
  if (byType) return byType.id;
  throw new Error(`Unknown Linear state "${nameOrType}" for team ${teamKey}`);
}

export async function listMyIssues(states: string[], teams?: string[]): Promise<LinearIssue[]> {
  try {
    // states are type-level names like "triage", "backlog", etc.
    const filter: Record<string, unknown> = {
      assignee: { isMe: { eq: true } },
      state: { type: { in: states } },
    };
    if (teams?.length) filter.team = { key: { in: teams } };
    const data = await gql<{ issues: { nodes: { identifier: string; title: string; state: { name: string; type: string }; priority: number }[] } }>(
      `query($filter: IssueFilter!) {
        issues(filter: $filter, orderBy: updatedAt, first: 50) {
          nodes { identifier title state { name type } priority }
        }
      }`,
      { filter },
    );
    return data.issues.nodes.map(n => ({
      id: n.identifier,
      title: n.title,
      state: n.state.type,
      priority: n.priority,
    }));
  } catch { return []; }
}

export async function getIssue(issueId: string): Promise<LinearIssue | null> {
  try {
    const data = await gql<{ issue: { identifier: string; title: string; state: { name: string; type: string }; priority: number; url: string } }>(
      `query($id: String!) {
        issue(id: $id) { identifier title state { name type } priority url }
      }`,
      { id: issueId },
    );
    const i = data.issue;
    return { id: i.identifier, title: i.title, state: i.state.type, priority: i.priority, url: i.url };
  } catch { return null; }
}

export async function createIssue(opts: {
  title: string;
  priority?: number;
  label?: string;
  team?: string;
}): Promise<string> {
  // Need team ID to create an issue
  const teamKey = opts.team;
  if (!teamKey) throw new Error('Team key required to create issue');

  const teamData = await gql<{ teams: { nodes: { id: string }[] } }>(
    `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
    { key: teamKey },
  );
  const teamId = teamData.teams.nodes[0]?.id;
  if (!teamId) throw new Error(`Team "${teamKey}" not found`);

  // Get the "started" state for auto-start
  const states = await getWorkflowStates(teamKey);
  const startedState = states.find(s => s.type === 'started');

  const input: Record<string, unknown> = {
    title: opts.title,
    teamId,
    assigneeId: (await gql<{ viewer: { id: string } }>('query { viewer { id } }')).viewer.id,
  };
  if (startedState) input.stateId = startedState.id;
  if (opts.priority) input.priority = opts.priority;

  const data = await gql<{ issueCreate: { issue: { identifier: string } } }>(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { identifier } }
    }`,
    { input },
  );
  return data.issueCreate.issue.identifier;
}

export async function updateIssueState(issueId: string, state: string, team?: string): Promise<void> {
  // Extract team key from issue ID (e.g. "KAD-4828" → "KAD")
  const teamKey = team || issueId.replace(/-\d+$/, '');
  const stateId = await resolveStateId(teamKey, state);
  await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId } },
  );
}

export async function getIssueUrl(issueId: string): Promise<string | null> {
  try {
    const data = await gql<{ issue: { url: string } }>(
      `query($id: String!) { issue(id: $id) { url } }`,
      { id: issueId },
    );
    return data.issue.url;
  } catch { return null; }
}
