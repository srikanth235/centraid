/*
 * J6 — single-source native build numbers from semver.
 * major*1e6 + minor*1e3 + patch — reproducible from source, no remote counter.
 *
 * Keep the body identical to version-core.cjs (Expo app.config loads the CJS
 * twin via Node require). version-core.test.ts asserts both paths agree.
 */

export function nativeBuildNumber(version: string): number {
  const m = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version.trim());
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m.groups?.major);
  const minor = Number(m.groups?.minor);
  const patch = Number(m.groups?.patch);
  return major * 1_000_000 + minor * 1_000 + patch;
}
