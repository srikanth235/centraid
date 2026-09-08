/*
 * The READ-shaped arrangements (#890 W3) — dayone, offline, stale — plus the
 * enumeration, seeding and status helpers every suite in this tier shares. The
 * write-shaped states (pending, conflict, parked, denied) live in
 * `write-conditions.ts`; that split is the repo's 500-line file cap, not a
 * boundary in the tier.
 *
 * Each function puts a REAL gateway and a REAL native replica session into its
 * state and hands back what the session reports, so the suites assert on a
 * state that was PRODUCED rather than on a fixture that was handed over.
 *
 * Two rules hold across all of them:
 *
 * - Nothing is stubbed. "Offline" is a socket that refuses to connect and
 *   "stale" is a second device writing while this one is not looking.
 * - Every arrangement carries its NEGATIVE half — the same read once a row
 *   really lands, the same pull on a live transport — because an arrangement
 *   that can only produce one answer proves nothing about which half produced
 *   it.
 */

import { ROUTES } from "../../../packages/core/src/protocol/index.js";
import type { SeatLogPageWire } from "../../../packages/core/src/protocol/index.js";
import { isBlocked, recipeFor } from "./apps.js";
import type { ActionCall, AppRecipe, SeededRow } from "./apps.js";
import type { MobileGateway } from "./gateway.js";
import { appsDesigning, unknownDesignedStates } from "./manifests.js";
import type { AppState } from "./manifests.js";
import { entityIdColumn, readEntity } from "./reads.js";
import type { MobileSeat } from "./seat.js";

/**
 * WHAT "HOW CURRENT AM I" MEANS ON A SEAT (#996, W5).
 *
 * It used to be a store `status()` — a mode, a shaped cursor and a coverage
 * that a windowed bootstrap could leave half-true. A seat holds the file or it
 * does not, so the honest answer is the WATERMARK: a log position, or nothing
 * at all before the copy has landed.
 */
export interface SeatStatus {
  /** The applied log position, or `null` before this seat holds a copy. */
  cursor: number | null;
  /** "complete" once the file is here; there is no half-here. */
  coverage: string | undefined;
}

export function seatStatus(seat: MobileSeat): SeatStatus {
  const watermark = seat.session.watermark();
  return {
    cursor: watermark ? watermark.applied : null,
    coverage: watermark ? "complete" : undefined,
  };
}

/** What `pendingChanges()` reports, reduced to what these suites read. */
export interface PendingEntry {
  intentId: string;
  status?: string;
  reason?: string;
  expectedVersion?: number;
  actualVersion?: number;
}

/** One row of a state suite's enumeration: an app, and how it is served. */
export interface EnumeratedApp {
  appId: string;
  recipe: AppRecipe;
  /** Present when this tier cannot reach the state for this app, with why. */
  blocked?: string;
}

/**
 * The apps a state is designed for, each resolved to a recipe or to a stated
 * blocker. THROWS — rather than skipping — when a manifest declares a state
 * this tier has no entry for, because a silent skip is exactly how a ninth app
 * or a widened manifest escapes the grid while the suite stays green.
 */
export async function enumerate(state: AppState): Promise<EnumeratedApp[]> {
  const unknown = await unknownDesignedStates();
  if (unknown.length > 0) {
    throw new Error(
      `app manifests declare states this tier does not know: ${unknown.join(", ")} — ` +
        "add them to APP_STATES in lib/manifests.ts and give every app an arrangement or a stated blocker"
    );
  }
  return (await appsDesigning(state)).map((appId) => {
    const recipe = recipeFor(appId);
    if (!recipe) {
      throw new Error(
        `${appId}/app.json declares "${state}" designed but tests/integration-mobile/lib/apps.ts ` +
          "has no recipe for the app — add one, or state a blocker; never leave the cell unenumerated"
      );
    }
    return isBlocked(recipe.park) && state === "parked"
      ? { appId, recipe, blocked: recipe.park.blocked }
      : { appId, recipe };
  });
}

/** Execute a create on the gateway without telling the phone about it. */
export async function serverCreate(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe,
  label: string
): Promise<void> {
  const call = await recipe.create({ gateway, seat, label });
  const outcome = await gateway.callAction(
    recipe.appId,
    call.action,
    call.input
  );
  if (outcome.body.status !== "executed") {
    throw new Error(
      `${recipe.appId}.${call.action} did not execute: ${JSON.stringify(outcome.body)}`
    );
  }
}

/**
 * Create one canonical row and let the phone catch up to it, then read the row
 * back FROM THE REPLICA. The id these suites carry has to be the one the
 * replica knows, because that is the id the pending projection and the
 * base-version capture will use.
 */
export async function seedRow(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe,
  label: string
): Promise<SeededRow> {
  await serverCreate(gateway, seat, recipe, label);
  await seat.session.pullNow();
  const read = await readEntity(seat, recipe.entity);
  const row = read.rows.at(-1);
  if (!row) {
    throw new Error(
      `${recipe.appId} create executed but ${recipe.entity} is still empty on the replica`
    );
  }
  const idColumn = entityIdColumn(recipe.entity);
  return { rowId: String(row[idColumn]), values: row };
}

export async function queuedCall(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe,
  label: string,
  seed?: SeededRow
): Promise<ActionCall> {
  return recipe.queuedWrite({
    gateway,
    seat,
    label,
    ...(seed ? { seed } : {}),
  });
}

/** DAYONE — a vault with no rows for this app, and a session that says so. */
export async function arrangeDayone(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  emptyRows: number;
  cursor: number | null;
  coverage: string | undefined;
  seededRows: number;
}> {
  const empty = await readEntity(seat, recipe.entity);
  const status = seatStatus(seat);
  // The negative: the same read, on the same session, after the vault really
  // holds one row. Without it, "empty" could be a read that never works.
  await seedRow(gateway, seat, recipe, "dayone-negative");
  const seeded = await readEntity(seat, recipe.entity);
  return {
    emptyRows: empty.rows.length,
    cursor: status.cursor,
    coverage: status.coverage,
    seededRows: seeded.rows.length,
  };
}

/** OFFLINE — the transport refuses to connect; the replica still answers. */
export async function arrangeOffline(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  cutPullLanded: boolean;
  rowsWhileCut: number;
  cursorWhileCut: number | null;
  restoredPull: boolean;
  rowsAfterRestore: number;
}> {
  await seedRow(gateway, seat, recipe, "offline-seed");
  const seededRows = (await readEntity(seat, recipe.entity)).rows.length;
  seat.cut();
  let cutPullLanded: boolean;
  let whileCutRows: number;
  let cutStatus;
  try {
    // A second device writes while this phone is unreachable, so the restored
    // pull has something to land — otherwise "the pull worked again" would be
    // indistinguishable from "nothing happened either way".
    await serverCreate(gateway, seat, recipe, "offline-while-cut");
    // NOT A THROW, AND DELIBERATELY (#996, W5). A seat that could not reach the
    // gateway is a seat with a slightly older copy, which is the normal state
    // of the thing; the outage is REPORTED, as the boolean the refresh spinner
    // reads, rather than raised as an error a screen would have to catch.
    cutPullLanded = await seat.session.pullNow();
    whileCutRows = (await readEntity(seat, recipe.entity)).rows.length;
    cutStatus = seatStatus(seat);
  } finally {
    // A cut that outlives its own arrangement poisons every later app in the
    // file, and the failure then names the wrong test.
    seat.restore();
  }
  const restoredPull = (await seat.session.pullNow()) !== false;
  const restored = await readEntity(seat, recipe.entity);
  return {
    cutPullLanded,
    // The offline claim in one number: the cut read still serves what the
    // replica already had.
    rowsWhileCut: whileCutRows - (seededRows - 1),
    cursorWhileCut: cutStatus.cursor,
    restoredPull,
    rowsAfterRestore: restored.rows.length - (seededRows - 1),
  };
}

/** STALE — reachable, but the gateway has advanced past this session's cursor. */
export async function arrangeStale(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  staleRows: number;
  staleChangesAhead: number;
  freshRows: number;
  freshChangesAhead: number;
}> {
  await seedRow(gateway, seat, recipe, "stale-seed");
  const baseline = (await readEntity(seat, recipe.entity)).rows.length;
  // A second device writes and this session does NOT pull. Its cursor is now
  // behind the gateway's, which is the whole of what stale means here.
  await serverCreate(gateway, seat, recipe, "stale-behind");
  const stale = await readEntity(seat, recipe.entity);
  const staleChangesAhead = await changesAhead(gateway, seat);
  // The negative: one pull on the same session, and the same two questions.
  await seat.session.pullNow();
  const fresh = await readEntity(seat, recipe.entity);
  return {
    staleRows: stale.rows.length - baseline,
    staleChangesAhead,
    freshRows: fresh.rows.length - baseline,
    freshChangesAhead: await changesAhead(gateway, seat),
  };
}

/**
 * How many changes the gateway holds beyond this session's cursor, asked over
 * the real changes route with this session's own shape ids. This is the phone's
 * freshness question, not a peek into the vault's tables.
 */
export async function changesAhead(
  gateway: MobileGateway,
  seat: MobileSeat
): Promise<number> {
  const status = seatStatus(seat);
  if (status.cursor === null)
    throw new Error("the session has no cursor to compare");
  // THE SEAT'S OWN DOOR, not a shaped changes route: one page of the log from
  // where this file stands. What is ahead of the phone is what the log holds
  // past its applied position, and nothing about shapes enters into it.
  const url = new URL(ROUTES.vaultSeatLog, gateway.url);
  url.searchParams.set("since", String(status.cursor));
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      Accept: "application/json",
    },
  });
  const page = (await response.json()) as SeatLogPageWire;
  return page.rows.length;
}

export function intentIdOf(result: unknown): string {
  const intentId = (result as { intentId?: unknown }).intentId;
  if (typeof intentId !== "string")
    throw new Error(`a write returned no intent id: ${JSON.stringify(result)}`);
  return intentId;
}

/** The state the session reports for one intent, or undefined once it settled. */
export function statusOf(
  pending: readonly PendingEntry[],
  intentId: string
): string | undefined {
  return pending.find((entry) => entry.intentId === intentId)?.status;
}
