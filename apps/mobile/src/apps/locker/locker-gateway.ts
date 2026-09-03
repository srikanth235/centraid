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

export function lockerAccess(
  sessionToken: string,
  limit: number = ACCESS_WINDOW
): Promise<AccessPayload> {
  return appQuery<AccessPayload>("locker", "access", {
    auth_session: sessionToken,
    limit,
  });
}

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
