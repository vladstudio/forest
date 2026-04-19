function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'untitled';
}

/** Sanitize user input for use as a git branch name. */
export function sanitizeBranch(value: string): string {
  return value
    .replace(/[<>:"|?*\x00-\x1f\s~^\\]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/\/\//g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
}

/** Sanitize a string for use as a directory/file name (replaces /, .., special chars). */
export function sanitizeForFilePath(value: string): string {
  return value
    .replace(/\.\./g, '')
    .replace(/\//g, '--')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-');
}

/** Expand branchFormat template with ticketId and title. */
export function formatBranch(branchFormat: string, ticketId: string, title: string): string {
  return branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slugify(title));
}

/** Escape a value for safe interpolation into a shell command string. */
export function shellEscape(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9._\-/:@=]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
