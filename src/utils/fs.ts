import * as fs from 'fs';
import * as crypto from 'crypto';
import { log } from '../logger';

/** 8-char hex hash of a repo path, used to disambiguate repos with the same basename. */
export function repoHash(repoPath: string): string {
  return crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8);
}

/** Unlink a file, ignoring ENOENT. Logs other errors as warnings. */
export function tryUnlinkSync(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch (e: any) { if (e.code !== 'ENOENT') log.warn(`tryUnlinkSync(${filePath}): ${e.message}`); }
}
