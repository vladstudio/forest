import * as fs from 'fs';
import * as path from 'path';
import { exec, commandExists } from '../utils/exec';
import { notify } from '../notify';

let dockerCached: boolean | undefined;

export async function dockerAvailable(): Promise<boolean> {
  if (dockerCached !== undefined) return dockerCached;
  dockerCached = await commandExists('docker');
  return dockerCached;
}

/** Stop+remove dev containers (and their anonymous volumes) labeled for the given workspace folder. */
export async function cleanup(folderPath: string): Promise<{ removed: number }> {
  if (!await dockerAvailable()) return { removed: 0 };
  const filter = `label=devcontainer.local_folder=${folderPath}`;
  const { stdout } = await exec('docker', ['ps', '-aq', '--filter', filter]);
  const ids = stdout.split('\n').filter(Boolean);
  if (!ids.length) return { removed: 0 };
  await exec('docker', ['rm', '-f', '-v', ...ids]);
  return { removed: ids.length };
}

/** Bind-mount the main repo's `.git` into the worktree's devcontainer.json so git inside
 *  the container can resolve the worktree's `gitdir:` pointer. Idempotent. */
export async function ensureGitMount(treePath: string): Promise<void> {
  const devcontainerPath = path.join(treePath, '.devcontainer', 'devcontainer.json');
  if (!fs.existsSync(devcontainerPath)) return;

  let gitDir: string;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: treePath });
    gitDir = path.resolve(treePath, stdout.trim());
  } catch {
    return; // not a git worktree — nothing to mount
  }

  const raw = fs.readFileSync(devcontainerPath, 'utf8');
  let parsed: { mounts?: string[] } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    notify.warn(
      `Forest: cannot parse ${devcontainerPath} (${e.message}). Add this mount manually for git to work in the container:\n  source=${gitDir},target=${gitDir},type=bind`,
    );
    return;
  }

  const mounts = parsed.mounts ?? [];
  if (mounts.some(m => mountTarget(m) === gitDir)) return;
  parsed.mounts = [...mounts, `source=${gitDir},target=${gitDir},type=bind`];
  fs.writeFileSync(devcontainerPath, JSON.stringify(parsed, null, 2));
}

/** Extract the `target=...` value from a docker mount spec like `source=a,target=b,type=bind`. */
function mountTarget(spec: string): string | undefined {
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === 'target') return part.slice(eq + 1);
  }
  return undefined;
}
