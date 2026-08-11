// Home's sample-data offer (issue #708).
//
// A vault on day one is empty, and an empty archive is a poor argument for an
// archive. The handoff's Home is dense with content — that density IS the
// product's claim, and the one screen that cannot make it is the first one a
// member ever sees.
//
// The obvious fix is the dishonest one. This vault's whole promise is that
// everything in it is the member's own, so rows invented by us and presented as
// theirs would break the exact thing the product sells. What makes the offer
// legitimate is machinery that already exists (#290): a seeded row is written
// through the DEMO REGISTER — owner credential, `seed.demo` provenance, receipted,
// invisible to the automation plane, and purgeable in one act. So the sample is
// always identifiable as a sample and always removable as a whole.
//
// Three rules follow, and the surface has to hold all three:
//
//   • It is APPLIED ONCE, then never again without asking. A fresh vault fills
//     itself the first time Home opens, because an empty front door is a poor
//     argument for the product and an offer nobody accepts demonstrates
//     nothing. This reverses the original rule ("offered, never applied") — the
//     thing that makes it legitimate rather than presumptuous is the other two
//     rules plus the demo register underneath: the rows say what they are, and
//     one act removes them for good. `hasAutoSeeded` is what "for good" means.
//   • While it is loaded, Home SAYS SO — once, at vault level, beside the other
//     facts about the vault, not as a badge on every tile.
//   • Clearing it is one act, it is always in reach, and it is FINAL: nothing
//     refills a vault whose member has cleared it.

import {
  getUserPrefs,
  saveUserPrefs,
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
} from "../../../gateway-client.js";

/** What Home needs to know about the sample: can it be offered, is it loaded. */
export interface HomeSampleState {
  /** Apps that ship a scenario generator and could be seeded. */
  seedable: readonly string[];
  /** Rows currently carrying `seed.demo` provenance, across every app. */
  rows: number;
}

export const NO_SAMPLE: HomeSampleState = { rows: 0, seedable: [] };

/**
 * Read the demo plane's state.
 *
 * Fail-soft to "no sample available": a gateway that cannot answer should cost
 * the member an offer, never the whole front door.
 */
export async function loadHomeSample(): Promise<HomeSampleState> {
  try {
    const apps = await vaultDemoStatus();
    return {
      rows: apps.reduce((total, app) => total + app.rows, 0),
      seedable: apps.filter((app) => app.seedable).map((app) => app.appId),
    };
  } catch {
    return NO_SAMPLE;
  }
}

/**
 * Where a fill has got to.
 *
 * Emitted BEFORE each generator runs, so the surface names the app it is
 * WAITING ON rather than the one it just finished — "adding photographs" while
 * the ten uploads are in flight is the sentence that makes the wait legible;
 * the same sentence after they land describes nothing.
 */
export interface HomeSampleProgress {
  /** Generators that have already returned — seeded or thrown. */
  done: number;
  /** Generators this run will attempt. Fixed for the whole run. */
  total: number;
  /**
   * The app being seeded right now. `seedHomeSample` always names one; it is
   * optional because the SAME shape describes the run's closing replica
   * catch-up, which is one act rather than an eighth app.
   */
  appId?: string;
}

/**
 * Seed every app that can be seeded, one at a time, reporting where it is.
 *
 * Errors are swallowed PER APP, which is the same contract `Promise.allSettled`
 * gave this loop when it issued all seven at once: one generator throwing is
 * not the others' problem, and seven filled tiles beside one that still says
 * what to do is a far better outcome than an empty Home and an error.
 *
 * Sequential now, and the cost is nothing — the gateway's group-commit queue
 * serialised the actual writes anyway, so the concurrent version only ever
 * bought the right to finish in an unknowable order. What sequencing buys is
 * the whole point of this function's second argument: the run has a POSITION,
 * so the wait can be described ("adding photographs, 5 of 7") instead of
 * endured. Photos alone is ten uploads, which is most of the ten seconds a
 * member used to spend looking at a disabled label.
 *
 * Returns the ids that actually seeded, so a caller can say something true
 * about a partial result rather than claiming the whole week landed.
 */
export async function seedHomeSample(
  seedable: readonly string[],
  onProgress?: (progress: HomeSampleProgress) => void
): Promise<readonly string[]> {
  const seeded: string[] = [];
  for (const [index, appId] of seedable.entries()) {
    onProgress?.({ appId, done: index, total: seedable.length });
    try {
      // Ordered on purpose: this function IS the named, tested primitive the
      // rule asks ordered work to live behind, and the order is exactly what
      // `onProgress` reports.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await vaultDemoLoad(appId);
      seeded.push(appId);
    } catch {
      // Per-app failure is survivable and is REPORTED by omission from the
      // returned ids, exactly as the `allSettled` version reported it.
    }
  }
  return seeded;
}

/** Remove every seeded row in one act — the promise the offer is made on. */
export async function clearHomeSample(): Promise<void> {
  await vaultDemoPurge();
}

/**
 * The gateway pref recording which vaults have already had their one
 * automatic fill.
 *
 * WHY A DURABLE MARKER AND NOT "is the vault empty".
 *
 * The fill now runs on its own the first time a member opens Home on a fresh
 * vault, so the emptiness test that decides to run it is also true the instant
 * they press "Clear the sample" — and a surface that refills what you just
 * cleared has not cleared anything. The marker is what makes clearing FINAL:
 * asked and answered once per vault, and the answer outlives the rows.
 *
 * Keyed BY VAULT, because a member with two vaults gets the demonstration in
 * each; a single global flag would silently withhold it from every vault after
 * the first. It lives in gateway prefs rather than this device's storage so
 * that clearing on the desktop is still cleared when the phone pairs in — the
 * fill is a fact about the vault, not about a browser profile.
 */
const AUTO_SEED_PREF = "homeSampleAutoSeeded";

function autoSeededMap(
  prefs: Record<string, unknown>
): Record<string, boolean> {
  const raw = prefs[AUTO_SEED_PREF];
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, boolean>)
    : {};
}

/**
 * Has this vault already had its automatic fill?
 *
 * Fail-soft to TRUE — the one direction that cannot do damage. A prefs read
 * that fails means "we do not know", and the safe reading of not knowing is
 * "already done": worst case a fresh vault opens empty and keeps the manual
 * offer, where the other default would write invented rows into a vault whose
 * member may have cleared them minutes ago.
 */
export async function hasAutoSeeded(vaultId: string): Promise<boolean> {
  try {
    return autoSeededMap(await getUserPrefs())[vaultId] === true;
  } catch {
    return true;
  }
}

/**
 * The vault the automatic fill would land in, or null when that is not knowable
 * right now.
 *
 * `null` is not a vault and is never treated as one. An unknown vault means the
 * fill does not run — writing rows into a vault you cannot name is the one
 * outcome this feature must never produce, and the member still has the manual
 * offer.
 */
export async function autoSeedVaultId(): Promise<string | null> {
  try {
    return (await window.CentraidApi.getGatewayAuth()).vaultId ?? null;
  } catch {
    return null;
  }
}

/** Record that this vault's one automatic fill has been spent. */
export async function markAutoSeeded(vaultId: string): Promise<void> {
  try {
    const prefs = await getUserPrefs();
    await saveUserPrefs({
      [AUTO_SEED_PREF]: { ...autoSeededMap(prefs), [vaultId]: true },
    });
  } catch {
    // Nothing to do: the caller marks BEFORE it fills precisely so that a
    // failure here costs the fill rather than costing the member a loop.
  }
}

/**
 * Pull the rows a seed or purge just wrote into the local replica.
 *
 * The tiles read the REPLICA, not the gateway: a seed lands on the gateway
 * before `seedHomeSample` resolves, but the OPFS copy only catches up when the
 * change feed's SSE nudge arrives — which races the refresh that rebuilds the
 * tiles, so the payoff frame rebuilt from pre-seed rows and Home stayed empty
 * until a manual reload. Awaiting this before the refresh makes the order
 * true: rows in the replica, THEN queries rebuilt from them.
 *
 * Fail-soft by contract, same as `loadHomeSample`: stale tiles that the next
 * feed nudge repairs beat a front door stuck on `busy`, so a sync that cannot
 * run (no session yet, gateway briefly unreachable) resolves anyway and the
 * caller's refresh still happens.
 */
export async function syncHomeSampleReplica(): Promise<void> {
  try {
    // Lazy for the reason HomeRoute lazy-imports the tile reader: the shell
    // session drags the authed transport into the chunk at module load.
    const { getReplicaShellSession } =
      await import("../../../replica/shell-session.js");
    await (await getReplicaShellSession()).sync();
  } catch {
    // Deliberately swallowed — see the contract above.
  }
}
