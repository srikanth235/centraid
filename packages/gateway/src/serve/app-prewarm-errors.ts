/**
 * Classify app-asset prewarm failures so test vaults (and mid-install apps)
 * that have no index.html yet do not spam `logger.warn` on every plan install.
 */
export function isExpectedPrewarmSkip(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === 'object') {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|no such file or directory/i.test(message);
}
