/**
 * Operator Host allowlist helpers for non-loopback binds (issue #504 packaging).
 *
 * Loopback forms (localhost / 127.0.0.1 / ::1) are always accepted by
 * app-engine. Extra hostnames come from CLI flags and/or env so Docker
 * and host services can name the public Host clients will send.
 */

/** Parse `CENTRAID_ALLOWED_HOSTS` (comma-separated hostnames, no ports). */
export function parseAllowedHostsEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CENTRAID_ALLOWED_HOSTS;
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Merge CLI `--allowed-host` values with env. CLI entries first, then env;
 * duplicates dropped (case-insensitive).
 */
export function mergeAllowedHosts(
  cliHosts: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of [...(cliHosts ?? []), ...parseAllowedHostsEnv(env)]) {
    const n = h.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
