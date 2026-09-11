// W5.3 (#842) — released-binary skew: the PURE core of the lane.
//
// Night Watch's L6 pins n−1 by SOURCE (it checks out and builds the previous
// commit), but a real household never skews by source — a phone and a desktop
// skew by RELEASE. When a member upgrades one device and not the other, the
// bytes on the wire are last-released-client ⇄ tonight's-gateway, and NOTHING
// in the suite exercises that pair. This lane does: tonight's gateway is built
// from source by the pairing harness, and the DEVICE side is driven by the last
// PUBLISHED client artifact rather than the source tree.
//
// The artifact fetch is blocked-external until releases exist (W6): there is no
// published client to download yet. So the lane is split — this module owns the
// two decisions that can be proven WITHOUT a release (which is what the unit
// test pins), and the flow runner owns the live journey.
//
// Everything here is a pure function of its arguments (env object, result
// object). No process, no network, no filesystem — so `node --test` can pin the
// skip-with-citation vs run decision and the verdict judge deterministically.

/**
 * The tracking anchors this lane cites when it cannot run. Kept here so the
 * flow runner, the unit test, and the report all quote the same strings.
 */
export const SKEW_BLOCKERS = Object.freeze({
  // No client artifact has ever been published — the W6 release workstream is
  // the unblock. Until then the download step has nothing to fetch.
  noRelease:
    "blocked-external: no published client artifact to skew against — " +
    "unblocks when the W6 release workstream cuts the first client release " +
    "(#842 W5.3).",
});

/**
 * Resolve where the last-released client artifact lives, WITHOUT fetching it.
 *
 * Resolution order (first hit wins):
 *   1. CENTRAID_SKEW_CLIENT_DIR — an already-extracted released client tree
 *      (this is also how the fixture proves the lane logic in CI/local).
 *   2. CENTRAID_SKEW_RELEASE_TAG — a tag the flow runner will `gh release
 *      download`. Naming the tag is the caller asserting a release exists.
 *
 * With neither set the honest answer is `available:false` with the noRelease
 * citation — NOT a fabricated pass. `available:true` is only ever returned with
 * a concrete `source` the runner can drive; a truthy-but-empty env value is
 * treated as absent so a blank secret cannot masquerade as a rig.
 *
 * @param {Record<string, string|undefined>} env - the process env to read.
 * @returns {{available: true, kind: "dir"|"tag", source: string}
 *          | {available: false, reason: string}} the resolved client, or a
 *          blocked-external skip with its citation.
 */
export function resolveReleasedClient(env = {}) {
  const dir = nonEmpty(env.CENTRAID_SKEW_CLIENT_DIR);
  if (dir) return { available: true, kind: "dir", source: dir };

  const tag = nonEmpty(env.CENTRAID_SKEW_RELEASE_TAG);
  if (tag) return { available: true, kind: "tag", source: tag };

  return { available: false, reason: SKEW_BLOCKERS.noRelease };
}

/**
 * Judge a completed skew journey. This is where "honesty over green" lives: a
 * lane that claims a rig is available must PROVE the journey ran, or it fails.
 *
 * @param {{
 *   available: boolean,
 *   ran?: boolean,
 *   paired?: boolean,
 *   replicaConverged?: boolean,
 *   clientVersion?: string,
 *   gatewayVersion?: string,
 *   notes?: string[],
 * }} result - the journey outcome to judge.
 * @returns {{ verdict: "skip"|"pass"|"fail", reason: string }} the verdict and
 *          a human-readable reason.
 */
export function judgeSkewJourney(result) {
  if (!result || typeof result !== "object") {
    return { verdict: "fail", reason: "no result object produced" };
  }

  // Blocked-external: no rig. Skip with the citation — green, but LOUD.
  if (!result.available) {
    return {
      verdict: "skip",
      reason: result.reason || SKEW_BLOCKERS.noRelease,
    };
  }

  // Rig claimed available but the journey never executed — this is the
  // vacuous-pass trap the whole split exists to prevent. Fail, do not skip.
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
