export function nativeBuildNumber(version: string): number {
  const m = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(
    version.trim()
  );
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m.groups?.major);
  const minor = Number(m.groups?.minor);
  const patch = Number(m.groups?.patch);
  return major * 1_000_000 + minor * 1_000 + patch;
}
