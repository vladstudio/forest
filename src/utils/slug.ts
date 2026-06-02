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

/** Expand branchFormat template with ticketId and title. */
export function formatBranch(branchFormat: string, ticketId: string, title: string): string {
  return branchFormat
    .replace('${ticketId}', ticketId)
    .replace('${slug}', slugify(title));
}

/** Expand branchNamePrefix date tokens. */
export function formatBranchPrefix(prefix: string): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return prefix.replaceAll('{YYMMDD}', yy + mm + dd).replaceAll('{YY}', yy).replaceAll('{MM}', mm).replaceAll('{DD}', dd);
}

/** Escape a value for safe interpolation into a shell command string. */
export function shellEscape(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9._\-/:@=]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
