export function parseAllowedHostsEnv(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw = env.CENTRAID_ALLOWED_HOSTS;
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export function mergeAllowedHosts(
  cliHosts: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
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
