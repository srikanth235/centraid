export const UPGRADE_BLOCKERS = Object.freeze({
  noInstaller:
    "blocked-external: no mutable install/uninstall rig — the launchd " +
    "install/uninstall lane is a named #790 blocker (local opt-in only). " +
    "Unblocks when #790 provisions a mutable user-session installer runner " +
    "(#842 W5.4).",
});

export function resolvePreviousInstaller(env = {}) {
  const installer = nonEmpty(env.CENTRAID_UPGRADE_PREV_INSTALLER);
  if (installer) return { available: true, installer };
  return { available: false, reason: UPGRADE_BLOCKERS.noInstaller };
}

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
