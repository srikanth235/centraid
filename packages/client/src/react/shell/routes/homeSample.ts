// Home's sample-data offer (#708). Every seeded row goes through the DEMO
// REGISTER (#290): `seed.demo` provenance, receipted, invisible to automations,
// purgeable in one act. Three rules the surface must hold: DISCLOSE before
// writing; while loaded, Home says so once at vault level, never per tile;
// clearing is one act, always in reach.

import {
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
} from "../../../gateway-client.js";

export interface HomeSampleState {
  seedable: readonly string[];
  /** Rows carrying `seed.demo` provenance, across every app. */
  rows: number;
}

export const NO_SAMPLE: HomeSampleState = { rows: 0, seedable: [] };

/** Fail-soft to "no sample": a gateway that cannot answer costs an offer, never
 *  the front door. */
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

/** Emitted BEFORE each generator runs, so the surface names the app it is
 *  WAITING ON, not the one it just finished. */
export interface HomeSampleProgress {
  done: number;
  total: number;
  /** Optional only because the same shape describes the closing replica
   *  catch-up, which is one act rather than another app. */
  appId?: string;
}

/**
 * Errors are swallowed PER APP: one generator throwing is not the others'
 * problem. Sequential on purpose — the gateway serialises the writes anyway,
 * and a position is what lets the wait be described. Returns the ids that
 * actually seeded, so a caller can be honest about a partial result.
 */
export async function seedHomeSample(
  seedable: readonly string[],
  onProgress?: (progress: HomeSampleProgress) => void
): Promise<readonly string[]> {
  const seeded: string[] = [];
  for (const [index, appId] of seedable.entries()) {
    onProgress?.({ appId, done: index, total: seedable.length });
    try {
      // Ordered on purpose: this IS the named primitive ordered work lives
      // behind, and the order is what `onProgress` reports.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await vaultDemoLoad(appId);
      seeded.push(appId);
    } catch {
      // Per-app failure is reported by omission from the returned ids.
    }
  }
  return seeded;
}

export async function clearHomeSample(): Promise<void> {
  await vaultDemoPurge();
}

/**
 * AWAIT THIS BEFORE REFRESHING: tiles read the REPLICA, whose OPFS copy only
 * catches up on an SSE nudge that races the refresh. Fail-soft — stale tiles
 * beat a front door stuck on `busy`.
 */
export async function syncHomeSampleReplica(): Promise<void> {
  try {
    // Lazy: the shell session drags the authed transport into the chunk.
    const { getReplicaShellSession } =
      await import("../../../replica/shell-session.js");
    await (await getReplicaShellSession()).sync();
  } catch {
    // Swallowed by contract, above.
  }
}
