import { exec, commandExists } from '../utils/exec';

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
