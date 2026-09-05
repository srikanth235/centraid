// LOCKER'S THREE SECRET-FREE READS, AND THEY RUN HERE (#922 E7, #928).
//
// THE WINDOW IS THE GRANT'S, NOT THE SESSION'S. Listing an item is not
// unlocking it: `locker.item` visibility is authorised by the app grant alone,
// and authentication gates permits and `reveal` (#928). So the list, the
// shelves and the search are ordinary reads, and this seat runs the SAME
// `queries/*.ts` modules the web seat runs against its own mounted replica
// (`inline-query-ctx.native.ts`) instead of asking the gateway for each
// window. There is one matching rule and one decoration rule for both seats;
// they simply no longer need a network to reach them.
//
// WHAT DID NOT MOVE IS THE WHOLE SECRET HALF. The passphrase, the memory
// session, the one-shot permit and the revealed field stay in
// `locker-gateway.ts`, online-only, unchanged — a device that cannot reach the
// gateway still cannot unlock anything. What it CAN do is read the browsable
// half of its own vault: titles, usernames, addresses, stars and tags, none of
// which is a sealed column (`packages/vault/src/replica/locker-sealed-columns.test.ts`).
//
// The Watchtower decoration is asked for as `optional`: weak/reused are
// derived inside the sealed boundary, so a local read answers UNDECORATED
// rather than refusing, and the review register reads the missing keys off the
// rows and says the check did not run.

import itemsQuery from "@centraid/blueprints/apps/locker/queries/items";
import searchQuery from "@centraid/blueprints/apps/locker/queries/search";
import trashQuery from "@centraid/blueprints/apps/locker/queries/trash";
import type {
  ItemsPayload,
  LockerRow,
} from "@centraid/blueprints/apps/locker/types";
import type { InlineQueryRunnable } from "@centraid/client/replica/native";

import type { NativeInlineQuerySession } from "../../lib/replica/inline-query-ctx.native";
import { runNativeInlineQuery } from "../../lib/replica/inline-query-ctx.native";

const APP = "locker";

/** The query's own default window; 2,000 is its ceiling. */
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

/** What the search and trash queries answer with. */
export interface RowsPayload {
  items?: LockerRow[];
  vaultDenied?: VaultDenial | null;
}

/**
 * The mounted read plane, handed over by the frame.
 *
 * Module-level for the same reason `locker-store.ts` is: the plane is process
 * memory shared by ten routes, and threading it through every screen would let
 * a remount hand a subtree a session the member has navigated away from.
 * `LockerScreen.tsx` attaches it on mount and detaches on unmount.
 */
let plane: NativeInlineQuerySession | undefined;

export function attachLockerReadPlane(
  session: NativeInlineQuerySession | undefined
): void {
  plane = session;
}

/**
 * There is no replica on this device yet — a first open before the bootstrap
 * lands, or a member with no vault linked. A sentence, not a crash: an empty
 * locker drawn over rows the vault holds is the one lie this app cannot tell.
 */
export class LockerReadPlaneUnavailableError extends Error {
  constructor() {
    super("This device has not finished mounting the vault yet.");
    this.name = "LockerReadPlaneUnavailableError";
  }
}

/**
 * `queries/*.ts` export the handler as the module's default; the runner takes
 * the MODULE, exactly as the web seat's `app-inline.tsx` hands it one.
 */
function runQuery<T>(
  handler: unknown,
  input: Record<string, unknown>
): Promise<T> {
  if (!plane) return Promise.reject(new LockerReadPlaneUnavailableError());
  return runNativeInlineQuery({ default: handler } as InlineQueryRunnable, {
    session: plane,
    appId: APP,
    input,
  }) as Promise<T>;
}

/** The bounded window of secret-free rows. `archived` is the shelf, and it is
 *  a DIFFERENT read: archived rows are out of the default window by
 *  construction, so slicing fetched rows would draw an empty shelf over a full
 *  one. */
export function lockerItems(
  limit: number = ITEMS_WINDOW,
  archived = false
): Promise<ItemsPayload> {
  return runQuery<ItemsPayload>(itemsQuery, {
    limit,
    ...(archived ? { archived: true } : {}),
  });
}

/** Titles, usernames and addresses. The matching runs over fields the payload
 *  never returns; notes and secret values are not among them. */
export function lockerSearch(term: string): Promise<RowsPayload> {
  return runQuery<RowsPayload>(searchQuery, { term });
}

/** Trashed rows with their purge dates — the same secret-free shape. */
export function lockerTrash(): Promise<RowsPayload> {
  return runQuery<RowsPayload>(trashQuery, {});
}
