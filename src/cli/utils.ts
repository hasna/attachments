/**
 * CLI utility helpers for formatting and error output.
 */

/**
 * Format a byte count into a human-readable string.
 * Examples: 1258291 → "1.2 MB", 556032 → "543 KB", 12 → "12 B"
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Format an expiry timestamp into a human-readable string.
 * Returns "Never" if expiresAt is null, otherwise a locale date/time string.
 */
export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "Never";
  return new Date(expiresAt).toLocaleString();
}

/**
 * Print a red error message to stderr and exit with code 1.
 */
export function exitError(msg: string): never {
  process.stderr.write(`\x1b[31mError: ${msg}\x1b[0m\n`);
  process.exit(1);
}
