// THE ONLINE HALF'S DOOR, and it is the gateway's — never the replica's.
//
// A revealed field is the one thing this seat must never hand a durable store
// (docs/mobile-offline.md, "Locker is stricter than the ordinary replica
// plane"), so every call here is a direct online request with no queue behind
// it. The passphrase, the session token and the one-shot permit that used to
// be three more are GONE (#996, ruling W6-D2): the boundary is the OS prompt
// over `K` and the unseal happens in `locker-door.ts`, on this device, with
// the radio off if need be. The browsable half does NOT come through this file: the list, the
// shelves and the search are the app grant's to read and run against this
// device's own replica in `locker-reads.ts` (#928). The metadata writes —
// star, tags, trash, restore — go through the replica's pending path, in
// `locker-writes.ts`.
//
// The staged-import plane belongs in this file for the same promise: an import
// payload is the file itself, every secret in it, so it must stay as far from
// the durable outbox as a typed password is, and keeping every call that could
// break that in one place is what makes the promise checkable.

import type {
  StagedBatch,
  StagedRow,
} from "@centraid/blueprints/apps/locker/import-model";
import type {
  LockerAccessEntry,
  LockerDetail,
} from "@centraid/blueprints/apps/locker/types";

import {
  apiHeaders,
  appQuery,
  fetchJson,
  requireGatewayBase,
} from "../../lib/gateway";
import type { VaultDenial } from "./locker-reads";

export interface ItemPayload {
  item?: LockerDetail | null;
  authRequired?: boolean;
  vaultDenied?: VaultDenial | null;
}

/**
 * Open one item's browsable detail. NOT a secret-bearing read any more: the
 * vault hands back metadata and ciphertext, and `locker-door.ts` turns the
 * ciphertext into a value behind the OS prompt. There is no token to spend,
 * which is what lets the pane paint while the Locker is locked.
 */
export function lockerItem(itemId: string): Promise<ItemPayload> {
  return appQuery<ItemPayload>("locker", "item", { item_id: itemId });
}

/**
 * THE REVEAL RECEIPT (#996, W6-D2) — the journal row `gateway.reveal` wrote,
 * posted through the ordinary device-intent path now that the unseal is local.
 *
 * It is the ONLY record that anyone looked, so `locker-door.ts` awaits it
 * before it hands a value to a screen. Offline it queues like any other device
 * write: the reveal still happened, and the record catches up.
 */
export function lockerRevealReceipt(input: {
  rowId: string;
  entity: string;
  columns: readonly string[];
  keyId: string;
}): Promise<{ receiptId?: string }> {
  return appQuery<{ receiptId?: string }>("locker", "reveal-receipt", {
    entity: input.entity,
    entity_id: input.rowId,
    columns: [...input.columns],
    key_id: input.keyId,
  });
}

/** The query's own default receipts window, and the number `accessWindowCopy`
 *  states. */
export const ACCESS_WINDOW = 200;

export interface AccessPayload {
  entries?: LockerAccessEntry[];
  window?: number;
  truncated?: boolean;
  authRequired?: boolean;
  vaultDenied?: VaultDenial | null;
}

/**
 * The receipt stream, under the grant's own `object_type` row filter.
 *
 * ONLINE-ONLY BY CONSTRUCTION: there is no cached history to fall back to and
 * there must not be — a cached one would draw what this device happened to hold
 * as the vault's whole record. NO ROW CARRIES A VALUE; the query answers acts,
 * items and column NAMES, and `access-model.ts` projects them into lines.
 */
export function lockerAccess(
  limit: number = ACCESS_WINDOW
): Promise<AccessPayload> {
  return appQuery<AccessPayload>("locker", "access", { limit });
}

// ─── The staged-import plane ────────────────────────────────────────────────
//
// The gateway's owner-tier workflow, where a password-manager CSV becomes
// `locker.item` rows (`packages/vault/src/ingest/stage-file.ts`).
//
// DRAFT → REVIEW → PUBLISH: nothing reaches the vault until the draft is
// published. Every call is a direct online request with no queue behind it, by
// construction, because the payload is the member's file.

const IMPORTS = "/centraid/_vault/imports";

/** What staging one file answers with. `unrouted` is the refusal that matters:
 *  a file the border recognised nothing in stages a draft holding no rows. */
export interface StagedImport {
  batchId: string;
  kind?: string;
  staged?: Record<string, number>;
  total?: number;
  unrouted?: string[];
}

export interface PublishedImport {
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: unknown[];
}

/** Stage one picked file into a reviewable draft. The text is the file, so it
 *  is handed straight to the border and never held by this module. */
export async function stageLockerImport(input: {
  filename: string;
  text: string;
}): Promise<StagedImport> {
  const base = await requireGatewayBase();
  return fetchJson<StagedImport>(`${base}${IMPORTS}`, {
    body: JSON.stringify(input),
    headers: apiHeaders({ "content-type": "application/json" }),
    method: "POST",
  });
}

/** Every batch the vault holds, in every status — `draftBatches` is what
 *  narrows them to the drafts a review can act on. */
export async function lockerImportBatches(): Promise<StagedBatch[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ batches?: StagedBatch[] }>(
    `${base}${IMPORTS}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.batches ?? [];
}

/** One draft's staged rows, with the disposition each was given. Dispositions
 *  and column mappings only — a staged row carries no value here. */
export async function lockerImportRows(batchId: string): Promise<StagedRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ rows?: StagedRow[] }>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.rows ?? [];
}

/** Apply the draft. One act over the whole batch, and the vault wins every
 *  collision — a row whose secret the vault already holds is skipped, not
 *  overwritten. */
export async function publishLockerImport(
  batchId: string
): Promise<PublishedImport> {
  const base = await requireGatewayBase();
  return fetchJson<PublishedImport>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}/publish`,
    { headers: apiHeaders(), method: "POST" }
  );
}

/** Drop the draft. Nothing was ever in the vault, so nothing is undone. */
export async function discardLockerImport(batchId: string): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<{ receiptId?: string }>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}/discard`,
    { headers: apiHeaders(), method: "POST" }
  );
}
