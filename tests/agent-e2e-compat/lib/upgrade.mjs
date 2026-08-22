// W5.4 (#842) — install / upgrade lifecycle: the PURE core of the lane.
//
// No lane installs a PREVIOUS release, upgrades in place over real data, and
// then runs a journey against the upgraded install. The launchd install /
// uninstall rig this needs is a NAMED #790 blocker ("No named mutable macOS
// user-session rig; local opt-in only" — TESTING.md §Named live/hardware
// lanes). So, like the skew lane, this splits: the installer half is blocked
// external, and the part that can be proven without an installer — the
// upgrade-over-data assertion logic — lives here and is unit-pinned.
//
// The load-bearing promise of an in-place upgrade is that the OLD vault's data
// survives the swap byte-for-byte. `assertUpgradePreservedData` is that
// promise as a pure function of a before/after snapshot, so the fixture can
// prove the assertion catches a dropped or mutated row WITHOUT a real
// installer, and the live flow can reuse the exact same judge once #790 lands a
// rig.

/**
 * The tracking anchor this lane cites when it cannot run the install half.
 */
export const UPGRADE_BLOCKERS = Object.freeze({
  noInstaller:
    "blocked-external: no mutable install/uninstall rig — the launchd " +
    "install/uninstall lane is a named #790 blocker (local opt-in only). " +
    "Unblocks when #790 provisions a mutable user-session installer runner " +
    "(#842 W5.4).",
});

/**
 * Resolve the previous-release installer WITHOUT running it.
 *
 *   CENTRAID_UPGRADE_PREV_INSTALLER — a path to the previous release's
 *     installer/artifact the runner will install, then upgrade over.
 *
 * Absent (or blank) → `available:false` with the #790 citation. Never a
 * fabricated pass.
 *
 * @param {Record<string, string|undefined>} env - the process env to read.
 * @returns {{available: true, installer: string} | {available: false, reason: string}}
 *          the resolved installer, or a #790 blocked-external skip.
 */
export function resolvePreviousInstaller(env = {}) {
  const installer = nonEmpty(env.CENTRAID_UPGRADE_PREV_INSTALLER);
  if (installer) return { available: true, installer };
  return { available: false, reason: UPGRADE_BLOCKERS.noInstaller };
}

/**
 * A vault snapshot for the upgrade assertion: a stable map from an opaque
 * record key to a content digest. The lane takes one BEFORE the in-place
 * upgrade and one AFTER, and this function proves the upgrade preserved every
 * record exactly.
 *
 * Preserved means, for every key present before: still present after, and its
 * digest unchanged. New keys after the upgrade are allowed (a migration may add
 * rows); a DROPPED or MUTATED pre-existing record is the failure this catches.
 *
 * @param {Record<string, string>} before - digest map before the upgrade.
 * @param {Record<string, string>} after - digest map after the upgrade.
 * @returns {{ ok: true } | { ok: false, dropped: string[], mutated: string[] }}
 *          ok, or the pre-existing keys that vanished or changed.
 */
export function assertUpgradePreservedData(before, after) {
  const beforeMap = asMap(before);
  const afterMap = asMap(after);

  const dropped = [];
  const mutated = [];
  for (const [key, digest] of beforeMap) {
    if (!afterMap.has(key)) {
      dropped.push(key);
      continue;
    }
    if (afterMap.get(key) !== digest) mutated.push(key);
  }

  if (dropped.length === 0 && mutated.length === 0) return { ok: true };
  return { ok: false, dropped: dropped.sort(), mutated: mutated.sort() };
}

/**
 * Judge a completed install/upgrade journey. Same honesty contract as the skew
 * judge: a claimed-available rig that did not actually install → fail, not skip.
 *
 * @param {{
 *   available: boolean,
 *   reason?: string,
 *   installedPrev?: boolean,
 *   upgraded?: boolean,
 *   preservation?: { ok: boolean, dropped?: string[], mutated?: string[] },
 *   journalPassed?: boolean,
 * }} result - the journey outcome to judge.
 * @returns {{ verdict: "skip"|"pass"|"fail", reason: string }} the verdict and
 *          a human-readable reason.
 */
export function judgeUpgradeJourney(result) {
  if (!result || typeof result !== "object") {
    return { verdict: "fail", reason: "no result object produced" };
  }

  if (!result.available) {
    return {
      verdict: "skip",
      reason: result.reason || UPGRADE_BLOCKERS.noInstaller,
    };
  }

  if (!result.installedPrev || !result.upgraded) {
    return {
      verdict: "fail",
      reason:
        "installer resolved but the previous-release install/upgrade did not " +
        "complete — refusing to report a vacuous pass",
    };
  }

  if (!result.preservation || !result.preservation.ok) {
    const dropped = result.preservation?.dropped ?? [];
    const mutated = result.preservation?.mutated ?? [];
    return {
      verdict: "fail",
      reason:
        "in-place upgrade did not preserve the old vault's data — " +
        `dropped ${JSON.stringify(dropped)}, mutated ${JSON.stringify(mutated)}`,
    };
  }

  if (!result.journalPassed) {
    return {
      verdict: "fail",
      reason: "upgraded install failed its post-upgrade journey",
    };
  }

  return { verdict: "pass", reason: "upgraded in place with data preserved" };
}

function asMap(obj) {
  if (obj instanceof Map) return obj;
  return new Map(Object.entries(obj ?? {}));
}

function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
