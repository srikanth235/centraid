// THE ONLY DOOR THIS SEAT HAS INTO LOCKER, and it is the gateway's — never
// the replica's.
//
// Every read here is an RPC to the app's own query handlers. Nothing touches
// `MobileReplicaSession.read` and nothing is cached in SQLite: a passphrase, a
// memory-session token, a one-shot permit and a revealed field are the four
// things this seat must never hand a durable store (docs/mobile-offline.md,
// "Locker is stricter than the ordinary replica plane"). The metadata writes —
// star, tags, trash, restore — DO go through the replica's pending path, in
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
  AuthPayload,
  ItemsPayload,
  LockerAccessEntry,
  LockerDetail,
  LockerRow,
} from "@centraid/blueprints/apps/locker/types";

import {
  apiHeaders,
  appQuery,
  fetchJson,
  requireGatewayBase,
} from "../../lib/gateway";

export const ITEMS_WINDOW = 300;
export const ITEMS_WINDOW_MAX = 2000;

export function nextWindow(current: number): number {
  return Math.min(ITEMS_WINDOW_MAX, current + ITEMS_WINDOW);
}

export interface VaultDenial {
  code?: string;
  message?: string;
}

export interface RowsPayload {
  items?: LockerRow[];
  vaultDenied?: VaultDenial | null;
}

export interface ItemPayload {
  item?: LockerDetail | null;
  authRequired?: boolean;
  vaultDenied?: VaultDenial | null;
}

export type AuthOperation =
  | "status"
  | "configure"
  | "unlock"
  | "authorize-item"
  | "lock"
  | "enroll-device"
  | "revoke-device";

export interface AuthRequest {
  operation: AuthOperation;
  sessionToken?: string;
  secret?: string;
  credentialId?: string;
  itemId?: string;
  label?: string;
}

/** The control plane. Passphrases are ARGUMENTS to this call and are never a
 *  field of anything this app holds afterwards. */
export function lockerAuth(request: AuthRequest): Promise<AuthPayload> {
  return appQuery<AuthPayload>("locker", "auth", {
    ...request,
  } as Record<string, unknown>);
}

export function lockerItems(
  sessionToken: string,
  limit: number = ITEMS_WINDOW
): Promise<ItemsPayload> {
  return appQuery<ItemsPayload>("locker", "items", {
    auth_session: sessionToken,
    limit,
  });
}

export function lockerItem(
  sessionToken: string,
  itemId: string,
  itemToken: string
): Promise<ItemPayload> {
  return appQuery<ItemPayload>("locker", "item", {
    auth_session: sessionToken,
    item_id: itemId,
    item_token: itemToken,
  });
}

/** Titles, usernames and addresses. Matching happens server-side over fields
 *  the payload never returns; notes and secret values are not among them. */
export function lockerSearch(term: string): Promise<RowsPayload> {
  return appQuery<RowsPayload>("locker", "search", { term });
}

export function lockerTrash(): Promise<RowsPayload> {
  return appQuery<RowsPayload>("locker", "trash", {});
}

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
  sessionToken: string,
  limit: number = ACCESS_WINDOW
): Promise<AccessPayload> {
  return appQuery<AccessPayload>("locker", "access", {
    auth_session: sessionToken,
    limit,
  });
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

export async function lockerImportBatches(): Promise<StagedBatch[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ batches?: StagedBatch[] }>(
    `${base}${IMPORTS}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.batches ?? [];
}

export async function lockerImportRows(batchId: string): Promise<StagedRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ rows?: StagedRow[] }>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.rows ?? [];
}

export async function publishLockerImport(
  batchId: string
): Promise<PublishedImport> {
  const base = await requireGatewayBase();
  return fetchJson<PublishedImport>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}/publish`,
    { headers: apiHeaders(), method: "POST" }
  );
}

export async function discardLockerImport(batchId: string): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<{ receiptId?: string }>(
    `${base}${IMPORTS}/${encodeURIComponent(batchId)}/discard`,
    { headers: apiHeaders(), method: "POST" }
  );
}
