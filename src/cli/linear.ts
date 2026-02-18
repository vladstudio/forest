import * as vscode from 'vscode';
import { log } from '../logger';

const API = 'https://api.linear.app/graphql';

let _apiKey: string | undefined;
let _authWarned = false;

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
  const opMatch = query.match(/^\s*(query|mutation)\s*(\w*)/);
  const opName = opMatch ? `${opMatch[1]} ${opMatch[2]}`.trim() : 'unknown';
  log.info(`Linear gql: ${opName}${variables ? ` vars=${JSON.stringify(variables)}` : ''}`);
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: _apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Linear API ${res.status}: ${res.statusText}${body ? ` — ${body}` : ''}`);
    if ((res.status === 401 || res.status === 403) && !_authWarned) {
      _authWarned = true;
      vscode.window.showWarningMessage('Forest: Linear API key is invalid or expired. Update linear.apiKey in .forest/local.json.');
    }
    throw new Error(`Linear API ${res.status}: ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
  const json = await res.json() as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    const errMsg = json.errors.map(e => e.message).join('; ');
    if (!json.data) {
      log.error(`Linear GraphQL error: ${errMsg}${variables ? ` (vars: ${JSON.stringify(variables)})` : ''}`);
      throw new Error(`Linear GraphQL error: ${errMsg}${variables ? ` (vars: ${JSON.stringify(variables)})` : ''}`);
    }
    log.warn(`Linear GraphQL partial error: ${errMsg}`);
  }
  log.info(`Linear gql ${opName}: ok`);
  return json.data as T;
}

// Cache workflow states per team (5-minute TTL)
type WorkflowState = { id: string; name: string; type: string; position: number };
const STATE_CACHE_TTL = 5 * 60_000;
const stateCache = new Map<string, { states: WorkflowState[]; time: number }>();

async function getWorkflowStates(teamKey: string): Promise<WorkflowState[]> {
  const cached = stateCache.get(teamKey);
  if (cached && Date.now() - cached.time < STATE_CACHE_TTL) return cached.states;
  const data = await gql<{ workflowStates: { nodes: WorkflowState[] } }>(
    `query($teamKey: String!) {
      workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
        nodes { id name type position }
      }
    }`,
    { teamKey },
  );
  const states = data.workflowStates.nodes;
  stateCache.set(teamKey, { states, time: Date.now() });
  return states;
}

/** Resolve a state name (custom like "In Review") or type (like "started") to a state ID. */
async function resolveStateId(teamKey: string, nameOrType: string): Promise<string> {
  const states = await getWorkflowStates(teamKey);
  const lower = nameOrType.toLowerCase();
  // Try exact name match first (case-insensitive)
  const byName = states.find(s => s.name.toLowerCase() === lower);
  if (byName) return byName.id;
  // Fall back to type match (pick lowest position when multiple states share a type)
  const byType = states.filter(s => s.type === lower).sort((a, b) => a.position - b.position);
  if (byType.length) return byType[0].id;
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
  } catch (e: any) { log.error(`listMyIssues failed: ${e.message}`); return []; }
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
  } catch (e: any) { log.error(`getIssue(${issueId}) failed: ${e.message}`); return null; }
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

  // Get the first "started" state for auto-start (lowest position in workflow)
  const states = await getWorkflowStates(teamKey);
  const startedState = states.filter(s => s.type === 'started').sort((a, b) => a.position - b.position)[0];

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
  log.info(`updateIssueState: ${issueId} → ${state}${team ? ` (team: ${team})` : ''}`);
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
