/**
 * J6 — single-source native build numbers from semver.
 * major*1e6 + minor*1e3 + patch — reproducible from source, no remote counter.
 *
 * Plain CJS so Expo's config evaluator (Node require-from-string) can load it
 * from app.config.ts. Keep in lockstep with version-core.ts.
 */

function nativeBuildNumber(version) {
  const m = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(
    String(version).trim()
  );
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m.groups?.major);
  const minor = Number(m.groups?.minor);
  const patch = Number(m.groups?.patch);
  return major * 1_000_000 + minor * 1_000 + patch;
}

module.exports = { nativeBuildNumber };
