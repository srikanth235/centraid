/*
 * The WRITE-shaped arrangements (#890 W3): pending, conflict, parked, denied.
 *
 * They share one spine — a write goes into the real `SqliteIntentStore`, the
 * drain ships it against a real gateway, and the suites read the outcome the
 * session reports — while the read-shaped states (dayone, offline, stale) live
 * beside them in `boot-conditions.ts`. The split is the repo's 500-line file
 * cap; the two halves are one tier and share `seedRow`, `enumerate` and the
 * status helpers from there.
 *
 * Every arrangement here carries its NEGATIVE half through the SAME session and
 * the SAME drain — a second write on a live transport, a row nobody touched, an
 * ordinary action beside the parking one, a write made before the revocation —
 * because an arrangement that can only produce one answer proves nothing about
 * which half produced it.
 */

import type { ActionCall, AppRecipe, SeededRow } from "./apps.js";
import {
  intentIdOf,
  queuedCall,
  seedRow,
  statusOf,
} from "./boot-conditions.js";
import type { PendingEntry } from "./boot-conditions.js";
import type { MobileGateway } from "./gateway.js";
import type { MobileSeat } from "./seat.js";

/** PENDING — a write in the durable outbox with the gateway unreachable. */
export async function arrangePending(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  queuedIntentId: string;
  queuedResult: { status?: string; reason?: string };
  queuedStatusWhileCut: string | undefined;
  overlayKeys: string[];
  liveIntentId: string;
  liveStatus: string | undefined;
}> {
  const seeds = recipe.queuedWriteNeedsSeed
    ? [
        await seedRow(gateway, seat, recipe, "pending-cut"),
        await seedRow(gateway, seat, recipe, "pending-live"),
      ]
    : [undefined, undefined];
  seat.cut();
  let queuedResult: { intentId: string; status?: string; reason?: string };
  let queuedStatusWhileCut: string | undefined;
  let overlayKeys: string[];
  try {
    queuedResult = (await seat.session.write(
      recipe.appId,
      await queuedCall(gateway, seat, recipe, "cut", seeds[0])
    )) as { intentId: string; status?: string; reason?: string };
    // Read the outbox WHILE the transport is still cut. Restoring it first
    // would let the very next write's drain ship this intent, and the suite
    // would be asking a settled queue what it used to hold.
    const pendingWhileCut =
      (await seat.session.pendingChanges()) as PendingEntry[];
    queuedStatusWhileCut = statusOf(pendingWhileCut, queuedResult.intentId);
    const overlay = await seat.session.read(recipe.appId, {
      entity: recipe.entity,
    });
    overlayKeys = overlay.rows.flatMap((row) => {
      const key = row.values["__centraid_pending_key"];
      return typeof key === "string" ? [key] : [];
    });
  } finally {
    seat.restore();
  }
  // The negative: the SAME shape of write, on a live transport, through the
  // same session. If it also reported itself queued, "queued" would be what
  // this write always says rather than what the outage made it say.
  const live = await seat.session.write(
    recipe.appId,
    await queuedCall(gateway, seat, recipe, "live", seeds[1])
  );
  return {
    queuedIntentId: queuedResult.intentId,
    queuedResult,
    queuedStatusWhileCut,
    overlayKeys,
    liveIntentId: intentIdOf(live),
    liveStatus: statusOf(
      (await seat.session.pendingChanges()) as PendingEntry[],
      intentIdOf(live)
    ),
  };
}

/** CONFLICT — a queued local edit and a server change on the same row. */
export async function arrangeConflict(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  contestedIntentId: string;
  untouchedIntentId: string;
  pending: PendingEntry[];
}> {
  const contestedRow = await seedRow(gateway, seat, recipe, "conflict-a");
  const untouchedRow = await seedRow(gateway, seat, recipe, "conflict-b");
  seat.cut();
  let contested: string;
  let untouched: string;
  try {
    contested = intentIdOf(
      await seat.session.write(recipe.appId, recipe.editSeeded(contestedRow))
    );
    // The negative rides the SAME session, the SAME action and the SAME drain —
    // only its row is left alone, so anything the contested intent reports that
    // this one does not is attributable to the server change.
    untouched = intentIdOf(
      await seat.session.write(recipe.appId, recipe.editSeeded(untouchedRow))
    );
  } finally {
    seat.restore();
  }
  await applyServerEdit(gateway, recipe, contestedRow);
  await seat.session.flushIntents();
  return {
    contestedIntentId: contested,
    untouchedIntentId: untouched,
    pending: (await seat.session.pendingChanges()) as PendingEntry[],
  };
}

/**
 * A second device edits the contested row. When the vault PARKS that edit —
 * every Agenda event command carries `confirm: true` — the owner confirms it,
 * because a parked ask has not moved the row and would leave the phone's
 * precondition nothing to collide with.
 */
async function applyServerEdit(
  gateway: MobileGateway,
  recipe: AppRecipe,
  row: SeededRow
): Promise<void> {
  const call = recipe.serverEdit(row);
  const outcome = await gateway.callAction(
    recipe.appId,
    call.action,
    call.input
  );
  if (outcome.body.status === "executed") return;
  if (outcome.body.status !== "parked") {
    throw new Error(
      `${recipe.appId}.${call.action} neither executed nor parked: ${JSON.stringify(outcome.body)}`
    );
  }
  const plane = gateway.handle.vaults.get(gateway.vaultId);
  if (!plane) throw new Error("the vault plane is not mounted");
  const confirmed = plane.confirmParked(
    String(outcome.body.invocationId),
    true
  );
  if (confirmed.status !== "executed") {
    throw new Error(
      `owner confirmation of ${recipe.appId}.${call.action} did not execute: ${JSON.stringify(confirmed)}`
    );
  }
}

/** PARKED — a write the vault holds for the owner's confirmation. */
export async function arrangeParked(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe,
  park: (seed: SeededRow) => ActionCall
): Promise<{
  parkedIntentId: string;
  parkedResult: { status?: string; reason?: string };
  ordinaryIntentId: string;
  pending: PendingEntry[];
}> {
  const row = await seedRow(gateway, seat, recipe, "parked-seed");
  // The negative first: an ORDINARY write of the same app, through the same
  // session and the same drain, must not park. A tier where everything parked
  // would pass the positive half on its own.
  const ordinary = intentIdOf(
    await seat.session.write(
      recipe.appId,
      await queuedCall(gateway, seat, recipe, "ordinary", row)
    )
  );
  const parkedResult = (await seat.session.write(recipe.appId, park(row))) as {
    intentId: string;
    status?: string;
    reason?: string;
  };
  return {
    parkedIntentId: parkedResult.intentId,
    parkedResult,
    ordinaryIntentId: ordinary,
    pending: (await seat.session.pendingChanges()) as PendingEntry[],
  };
}

/** DENIED — the owner revokes the app while a write waits behind an outage. */
export async function arrangeDenied(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  deniedIntentId: string;
  allowedIntentId: string;
  pending: PendingEntry[];
  grantsRevoked: number;
}> {
  const seeds = recipe.queuedWriteNeedsSeed
    ? [
        await seedRow(gateway, seat, recipe, "denied-allowed"),
        await seedRow(gateway, seat, recipe, "denied-revoked"),
      ]
    : [undefined, undefined];
  // The negative runs BEFORE the revocation: the same write, the same session,
  // against an app the owner still trusts.
  const allowed = intentIdOf(
    await seat.session.write(
      recipe.appId,
      await queuedCall(gateway, seat, recipe, "allowed", seeds[0])
    )
  );
  seat.cut();
  let denied: string;
  let grantsRevoked: number;
  try {
    denied = intentIdOf(
      await seat.session.write(
        recipe.appId,
        await queuedCall(gateway, seat, recipe, "revoked", seeds[1])
      )
    );
    const plane = gateway.handle.vaults.get(gateway.vaultId);
    if (!plane) throw new Error("the vault plane is not mounted");
    grantsRevoked = plane.revokeApp(recipe.appId).grantsRevoked;
  } finally {
    seat.restore();
  }
  await seat.session.flushIntents();
  return {
    deniedIntentId: denied,
    allowedIntentId: allowed,
    pending: (await seat.session.pendingChanges()) as PendingEntry[],
    grantsRevoked,
  };
}
