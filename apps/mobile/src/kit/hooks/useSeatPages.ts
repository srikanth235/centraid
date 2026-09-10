/*
 * A SCREEN READ, AS A PAGE OVER THIS PHONE'S OWN COPY (#996 wave 4b, R8).
 *
 * `useReplicaQuery` asks the old store for an ENTITY and a window. The forty-four
 * reads that declared `acceptTruncation` asked for an entity and no window at
 * all: "give me the default one", which was 1,000 rows, which nobody chose and
 * no screen said out loud. This hook is what those reads become — the same
 * `PageQuery` a blueprint handler writes, run by the same host, against the
 * seat's `vault.db` rather than `replica_row`/`payload_json`.
 *
 * WHY A WALK AND NOT ONE PAGE. Every one of those reads is a screen's whole
 * set — a task board's projects, a note's tags, the vault row a share sheet
 * names. `readPages` walks to the end of it and THROWS at the stated fan-out
 * bound, so a set that turned out to be unbounded is a failure with the
 * handler's name in it rather than a short list that reads as a complete one.
 *
 * A READ THAT IS GENUINELY A WINDOW takes `useSeatWindow` instead: one page,
 * the window the screen named, and the fact that the rows ran past it carried
 * back as `truncated` rather than swallowed. The springboard's newest 200
 * photographs and People's year-3 roster window are windows; walking either to
 * the end of a real library would read the whole library to draw a tile.
 *
 * NO SEAT IS NOT AN ERROR. A phone that has not finished copying the vault has
 * no `page` at all, and the honest answer is the one the browser gives when it
 * holds no file (R9, W4-D2): the rows are not here yet. `connection` carries
 * it, exactly as it carries a missing session, and no screen learns a new state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  JOIN_FAN_OUT,
  readPages,
} from "@centraid/blueprints/apps/_shared/paged-reads";
import type { FanOutBound } from "@centraid/blueprints/apps/_shared/paged-reads";
import { attachPendingSidecar } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";
import type { PageQuery } from "@centraid/core/page";

import { coalesceWork } from "../../lib/coalesce";
import { useReplica } from "../replica/ReplicaProvider";
import { replicaQueryConnection } from "./replica-query-state";
import type { ReplicaQueryState } from "./replica-query-state";

/** The same window `useReplicaQuery` collapses an invalidation burst into. */
const SEAT_INVALIDATION_WINDOW_MS = 120;

/** What a page of the seat hands back, as this module needs to read it. */
type SeatPage = <Row extends object>(request: {
  query: PageQuery<Row>;
  limit: number;
  after?: { sortKey: string; pk: string };
  overlay?: { entity: string; rowIdColumn: string };
}) => Promise<{ rows: Row[]; next?: { sortKey: string; pk: string } }>;

export interface SeatPagesOptions {
  /**
   * The entity whose invalidations re-run this read, and whose pending
   * mutations are drawn over it. A list read that drops the overlay shows the
   * member everything except their own unsettled write (R23–R25).
   */
  entity: string;
  /** The column carrying the row id — the `__rowId` every screen already reads. */
  rowIdColumn: string;
  /** How far the walk may go before the set it joins over is not bounded. */
  bound?: FanOutBound;
}

export interface SeatWindowOptions {
  entity: string;
  rowIdColumn: string;
  /** The window this screen named. One page of it, and no more. */
  limit: number;
}

/** A row as the screens read it: the table's columns plus `__rowId`. */
function withRowId(
  rows: readonly object[],
  rowIdColumn: string
): ReplicaQueryState["rows"] {
  return rows.map((row) => {
    const values = row as Record<string, unknown>;
    const id = values[rowIdColumn];
    return attachPendingSidecar(
      { ...values, __rowId: typeof id === "string" ? id : String(id) },
      {}
    ) as ReplicaQueryState["rows"][number];
  });
}

/** What one run of a seat read produced. */
interface SeatAnswer {
  rows: readonly object[];
  /** The rows ran past the window this read named. */
  truncated: boolean;
}

/**
 * The plumbing both seat reads share: the ticket, the invalidation
 * subscription, and the connection the screens already know how to draw.
 *
 * Held in ONE place because the difference between a walk and a window is the
 * three lines that call `page`, and two copies of the rest would be two
 * subscription lifetimes to keep in step.
 */
function useSeatRead(
  appId: string,
  query: PageQuery | undefined,
  entity: string,
  rowIdColumn: string,
  run: (page: SeatPage, query: PageQuery) => Promise<SeatAnswer>
): ReplicaQueryState {
  const replica = useReplica();
  // The PAGE, not the seat object: what this read depends on is the function
  // that runs its statement, and a provider that rebuilds its wrapper must not
  // re-walk every screen.
  const page = replica.seat?.page as SeatPage | undefined;
  const { session } = replica;
  const [rows, setRows] = useState<ReplicaQueryState["rows"]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  // Monotonic ticket so a slow older walk can never overwrite a newer one, and
  // a resolution after unmount is dropped instead of setting state.
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!page || !query) return;
    const ticket = (sequence.current += 1);
    const current = (): boolean =>
      mounted.current && ticket === sequence.current;
    try {
      const answer = await run(page, query);
      if (!current()) return;
      setRows(withRowId(answer.rows, rowIdColumn));
      setTruncated(answer.truncated);
      setError(undefined);
    } catch (caughtError) {
      if (!current()) return;
      // The raw string is for the LOG, where a debug session starts
      // (docs/logs.md) — never for the member. Screens word the failure
      // themselves through `kit/rooms/read-failure` (#1015, S14).
      console.warn("[seat-pages] read failed", query?.name, caughtError);
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      if (current()) setLoading(false);
    }
  }, [page, query, rowIdColumn, run]);

  useEffect(() => {
    if (!page || !query) return;
    void (async () => {
      await refresh();
    })();
    const coalesced = coalesceWork(refresh, SEAT_INVALIDATION_WINDOW_MS);
    // One entity change re-runs only the reads that depend on it (#922 E3); a
    // purge is the exception because it removes the plane every read stands on.
    const unsubscribe = session?.subscribe(appId, (invalidations) => {
      if (
        invalidations.some(
          (invalidation) =>
            invalidation.source === "purge" || invalidation.entity === entity
        )
      )
        coalesced.signal();
    });
    return () => {
      coalesced.cancel();
      unsubscribe?.();
    };
  }, [appId, entity, page, query, refresh, session]);

  const connection = replicaQueryConnection({
    ready: replica.ready,
    hasSession: page !== undefined,
    ...(replica.reachability ? { reachability: replica.reachability } : {}),
  });
  const lastSyncedAt = replica.scopes
    ?.flatMap((scope) => (scope.updatedAt ? [scope.updatedAt] : []))
    .sort((a, b) => b.localeCompare(a))[0];

  return {
    rows,
    loading: connection === "loading" || (page !== undefined && loading),
    connection,
    ...(!page && replica.error ? { unavailableReason: replica.error } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(truncated ? { truncated } : {}),
    ...(error ? { error } : {}),
    refresh,
  };
}

/**
 * Read a bounded set as pages over the seat.
 *
 * `query` may be `undefined` for the read a screen has not got its input for
 * yet — the id it was opened on, the filter it is waiting on. That is a read
 * that has not been made, not an empty one, so it holds `loading` rather than
 * claiming an empty set.
 */
export function useSeatPages(
  appId: string,
  query: PageQuery | undefined,
  options: SeatPagesOptions
): ReplicaQueryState {
  const { entity, rowIdColumn, bound } = options;
  const run = useCallback(
    async (page: SeatPage, statement: PageQuery): Promise<SeatAnswer> => ({
      rows: await readPages(
        { vault: { page } },
        statement,
        bound ?? JOIN_FAN_OUT,
        {
          entity,
          rowIdColumn,
        }
      ),
      // A walk that reached the end is the whole set; one that did not threw.
      truncated: false,
    }),
    [bound, entity, rowIdColumn]
  );
  return useSeatRead(appId, query, entity, rowIdColumn, run);
}

/**
 * Read ONE page of the window a screen named.
 *
 * The window is the screen's own claim — the newest 200 photographs, the
 * year-3 roster — so it is not a walk and never becomes one. What the old
 * store hid and this does not: whether the rows ran PAST the window.
 * `truncated` says so, `appliedLimit` says what cut it, and the notice is the
 * one sentence both seats word (#922 0a).
 */
export function useSeatWindow(
  appId: string,
  query: PageQuery | undefined,
  options: SeatWindowOptions
): ReplicaQueryState {
  const { entity, rowIdColumn, limit } = options;
  const run = useCallback(
    async (page: SeatPage, statement: PageQuery): Promise<SeatAnswer> => {
      const answer = await page({
        query: statement,
        limit,
        overlay: { entity, rowIdColumn },
      });
      return { rows: answer.rows, truncated: answer.next !== undefined };
    },
    [entity, limit, rowIdColumn]
  );
  const state = useSeatRead(appId, query, entity, rowIdColumn, run);
  return {
    ...state,
    appliedLimit: limit,
    ...(state.truncated
      ? { truncationNotice: truncatedListNotice(limit) }
      : {}),
  };
}
