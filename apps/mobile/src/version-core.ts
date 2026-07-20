/*
 * J6 — single-source native build numbers from semver.
 * major*1e6 + minor*1e3 + patch — reproducible from source, no remote counter.
 *
 * Keep the body identical to version-core.cjs (Expo app.config loads the CJS
 * twin via Node require). version-core.test.ts asserts both paths agree.
 */

export function nativeBuildNumber(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return major * 1_000_000 + minor * 1_000 + patch;
}
