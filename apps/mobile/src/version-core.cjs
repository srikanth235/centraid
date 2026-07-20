/**
 * J6 — single-source native build numbers from semver.
 * major*1e6 + minor*1e3 + patch — reproducible from source, no remote counter.
 *
 * Plain CJS so Expo's config evaluator (Node require-from-string) can load it
 * from app.config.ts. Keep in lockstep with version-core.ts.
 */

function nativeBuildNumber(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return major * 1_000_000 + minor * 1_000 + patch;
}

module.exports = { nativeBuildNumber };
