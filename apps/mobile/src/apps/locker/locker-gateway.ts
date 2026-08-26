// THE ONLY DOOR THIS SEAT HAS INTO LOCKER, and it is the gateway's — never
// the replica's.
//
// Every read below is an RPC to the app's own query handlers. Nothing here
// touches `MobileReplicaSession.read`, and nothing here is cached in SQLite:
// a passphrase, a memory-session token, a one-shot permit and a revealed
// field are the four things this seat must never hand a durable store
// (docs/mobile-offline.md, "Locker is stricter than the ordinary replica
// plane"). The metadata writes — star, tags, trash, restore — DO go through
// the replica's pending path, and they go through `locker-writes.ts`.
//
// The functions are thin on purpose. They name the query, they name what
// comes back, and they leave every decision about what a payload MEANS to
// `locker-store.ts` and to the pure blueprint modules it composes.

import type {
  AuthPayload,
  ItemsPayload,
  LockerDetail,
  LockerRow,
} from "@centraid/blueprints/apps/locker/types";

import { appQuery } from "../../lib/gateway";

/** The window the items read asks for. 300 is the query's own default and the
 *  number README-Locker §6's window sentence states; 2,000 is its ceiling. */
export const ITEMS_WINDOW = 300;
export const ITEMS_WINDOW_MAX = 2000;

/** One page more, capped at the query's own ceiling. */
export function nextWindow(current: number): number {
  return Math.min(ITEMS_WINDOW_MAX, current + ITEMS_WINDOW);
}

/** A vault refusal, as every query reports it. */
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

/** The bounded window of secret-free rows. */
export function lockerItems(
  sessionToken: string,
  limit: number = ITEMS_WINDOW
): Promise<ItemsPayload> {
  return appQuery<ItemsPayload>("locker", "items", {
    auth_session: sessionToken,
    limit,
  });
}

/** The ONE secret-bearing read, and it takes a one-shot item token. */
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

/** Trashed rows with their purge dates — the same secret-free shape. */
export function lockerTrash(): Promise<RowsPayload> {
  return appQuery<RowsPayload>("locker", "trash", {});
}
