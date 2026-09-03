export const SKEW_BLOCKERS = Object.freeze({
  noRelease:
    "blocked-external: no published client artifact to skew against — " +
    "unblocks when the W6 release workstream cuts the first client release " +
    "(#842 W5.3).",
});

export function resolveReleasedClient(env = {}) {
  const dir = nonEmpty(env.CENTRAID_SKEW_CLIENT_DIR);
  if (dir) return { available: true, kind: "dir", source: dir };

  const tag = nonEmpty(env.CENTRAID_SKEW_RELEASE_TAG);
  if (tag) return { available: true, kind: "tag", source: tag };

  return { available: false, reason: SKEW_BLOCKERS.noRelease };
}

export function judgeSkewJourney(result) {
  if (!result || typeof result !== "object") {
    return { verdict: "fail", reason: "no result object produced" };
  }

  if (!result.available) {
    return {
      verdict: "skip",
      reason: result.reason || SKEW_BLOCKERS.noRelease,
    };
  }

  if (!result.ran) {
    return {
      verdict: "fail",
      reason:
        "released client resolved but the skew journey did not run — refusing " +
        "to report a vacuous pass",
    };
  }

  if (!result.paired) {
    return {
      verdict: "fail",
      reason:
        "released client failed to pair with tonight's gateway " +
        `(client ${result.clientVersion ?? "?"} ⇄ gateway ${
          result.gatewayVersion ?? "?"
        }) — a wire-compat break across the release skew`,
    };
  }

  if (!result.replicaConverged) {
    return {
      verdict: "fail",
      reason:
        "paired but the replica journey did not converge across the skew — " +
        "the released client and tonight's gateway disagree on vault state",
    };
  }

  return {
    verdict: "pass",
    reason:
      `released client ${result.clientVersion ?? "?"} paired and converged ` +
      `against gateway ${result.gatewayVersion ?? "?"}`,
  };
}

function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
