import { fetchReplicaChanges } from "../../../packages/client/src/replica/shell-transport.js";
import type { ReplicaCursor } from "../../../packages/client/src/replica/types.js";
import { isBlocked, recipeFor } from "./apps.js";
import type { ActionCall, AppRecipe, SeededRow } from "./apps.js";
import type { MobileGateway } from "./gateway.js";
import { appsDesigning, unknownDesignedStates } from "./manifests.js";
import type { AppState } from "./manifests.js";
import type { MobileSeat } from "./seat.js";

export interface PendingEntry {
  intentId: string;
  status?: string;
  reason?: string;
  expectedVersion?: number;
  actualVersion?: number;
}

export interface EnumeratedApp {
  appId: string;
  recipe: AppRecipe;
  blocked?: string;
}

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

export async function seedRow(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe,
  label: string
): Promise<SeededRow> {
  await serverCreate(gateway, seat, recipe, label);
  await seat.session.pullNow();
  const read = await seat.session.read(recipe.appId, { entity: recipe.entity });
  const row = read.rows.at(-1);
  if (!row) {
    throw new Error(
      `${recipe.appId} create executed but ${recipe.entity} is still empty on the replica`
    );
  }
  return { rowId: row.rowId, values: row.values as Record<string, unknown> };
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

export async function arrangeDayone(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  emptyRows: number;
  cursor: ReplicaCursor | null;
  coverage: string | undefined;
  seededRows: number;
}> {
  const empty = await seat.session.read(recipe.appId, {
    entity: recipe.entity,
  });
  const status = await seat.session.status();
  await seedRow(gateway, seat, recipe, "dayone-negative");
  const seeded = await seat.session.read(recipe.appId, {
    entity: recipe.entity,
  });
  return {
    emptyRows: empty.rows.length,
    cursor: status.cursor,
    coverage: status.coverage,
    seededRows: seeded.rows.length,
  };
}

export async function arrangeOffline(
  gateway: MobileGateway,
  seat: MobileSeat,
  recipe: AppRecipe
): Promise<{
  cutPullError: string | undefined;
  rowsWhileCut: number;
  cursorWhileCut: ReplicaCursor | null;
  restoredPull: boolean;
  rowsAfterRestore: number;
}> {
  await seedRow(gateway, seat, recipe, "offline-seed");
  const seededRows = (
    await seat.session.read(recipe.appId, { entity: recipe.entity })
  ).rows.length;
  seat.cut();
  let cutPullError: string | undefined;
  let whileCutRows: number;
  let cutStatus;
  try {
    await serverCreate(gateway, seat, recipe, "offline-while-cut");
    try {
      await seat.session.pullNow();
    } catch (error) {
      cutPullError = error instanceof Error ? error.message : String(error);
    }
    whileCutRows = (
      await seat.session.read(recipe.appId, { entity: recipe.entity })
    ).rows.length;
    cutStatus = await seat.session.status();
  } finally {
    seat.restore();
  }
  const restoredPull = (await seat.session.pullNow()) !== false;
  const restored = await seat.session.read(recipe.appId, {
    entity: recipe.entity,
  });
  return {
    cutPullError,
    rowsWhileCut: whileCutRows - (seededRows - 1),
    cursorWhileCut: cutStatus.cursor,
    restoredPull,
    rowsAfterRestore: restored.rows.length - (seededRows - 1),
  };
}

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
  const baseline = (
    await seat.session.read(recipe.appId, { entity: recipe.entity })
  ).rows.length;
  await serverCreate(gateway, seat, recipe, "stale-behind");
  const stale = await seat.session.read(recipe.appId, {
    entity: recipe.entity,
  });
  const staleChangesAhead = await changesAhead(gateway, seat);
  await seat.session.pullNow();
  const fresh = await seat.session.read(recipe.appId, {
    entity: recipe.entity,
  });
  return {
    staleRows: stale.rows.length - baseline,
    staleChangesAhead,
    freshRows: fresh.rows.length - baseline,
    freshChangesAhead: await changesAhead(gateway, seat),
  };
}

export async function changesAhead(
  gateway: MobileGateway,
  seat: MobileSeat
): Promise<number> {
  const status = await seat.session.status();
  if (!status.cursor) throw new Error("the session has no cursor to compare");
  const batch = await fetchReplicaChanges(
    { baseUrl: gateway.url, token: gateway.token, vaultId: gateway.vaultId },
    status.cursor,
    new AbortController().signal,
    seat.session.catalog().map((shape) => shape.shapeId)
  );
  return batch.changes.length;
}

export function intentIdOf(result: unknown): string {
  const intentId = (result as { intentId?: unknown }).intentId;
  if (typeof intentId !== "string")
    throw new Error(`a write returned no intent id: ${JSON.stringify(result)}`);
  return intentId;
}

export function statusOf(
  pending: readonly PendingEntry[],
  intentId: string
): string | undefined {
  return pending.find((entry) => entry.intentId === intentId)?.status;
}
