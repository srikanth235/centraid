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
 * A read that is genuinely a window (the timeline, the roster) takes one page
 * and keeps its cursor; those never came through here.
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
import type { PageQuery } from "@centraid/core/page";

import { coalesceWork } from "../../lib/coalesce";
import { useReplica } from "../replica/ReplicaProvider";
import { replicaQueryConnection } from "./replica-query-state";
import type { ReplicaQueryState } from "./replica-query-state";

/** The same window `useReplicaQuery` collapses an invalidation burst into. */
const SEAT_INVALIDATION_WINDOW_MS = 120;

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
  const replica = useReplica();
  // The PAGE, not the seat object: what this read depends on is the function
  // that runs its statement, and a provider that rebuilds its wrapper must not
  // re-walk every screen.
  const page = replica.seat?.page;
  const { session } = replica;
  const [rows, setRows] = useState<ReplicaQueryState["rows"]>([]);
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

  const { entity, rowIdColumn, bound } = options;
  const refresh = useCallback(async () => {
    if (!page || !query) return;
    const ticket = (sequence.current += 1);
    const current = (): boolean =>
      mounted.current && ticket === sequence.current;
    try {
      const walked = await readPages(
        { vault: { page } },
        query,
        bound ?? JOIN_FAN_OUT,
        { entity, rowIdColumn }
      );
      if (!current()) return;
      setRows(withRowId(walked, rowIdColumn));
      setError(undefined);
    } catch (caughtError) {
      if (!current()) return;
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      if (current()) setLoading(false);
    }
  }, [bound, entity, page, query, rowIdColumn]);

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
    ...(error ? { error } : {}),
    refresh,
  };
}
