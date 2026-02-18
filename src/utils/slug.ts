export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

/** Escape a value for safe interpolation into a shell command string. */
export function shellEscape(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9._\-/:@=]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
