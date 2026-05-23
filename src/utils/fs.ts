import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** 8-char hex hash of a repo path, used to disambiguate repos with the same basename. */
export function repoHash(repoPath: string): string {
  return crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8);
}

/** Unlink a file, ignoring ENOENT. */
export function tryUnlinkSync(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}

export function safeRelativePath(root: string, value: string, label: string): string {
  if (!value || /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value)) throw new Error(`${label} must be a relative path: ${value}`);
  const parts = value.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error(`${label} cannot contain "..": ${value}`);
  const resolved = path.resolve(root, value);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} escapes ${root}: ${value}`);
  return resolved;
}
