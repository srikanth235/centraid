// The Connectors place's data half (#765): one read, two writes, and the
// re-authorization ceremony — nothing about layout or copy.
//
// The read is `listConnections()`; the writes are `setConnectionStatus()`
// (pause/resume) and the OAuth flow mobile already owns. That flow is
// deliberately NOT reimplemented here: `lib/connections.ts` re-exports the
// working pair under Connectors-facing names, and the browser half is the same
// in-app auth session Notifications opens — see `lib/connection-reauth.ts` for
// why a system browser cannot finish it on a phone.
//
// Every action re-reads the list afterwards rather than patching a row in
// place: health is the gateway's to report, and a row that says `Fine` because
// this screen assumed so is the failure mode the page exists to prevent.

import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpsState } from "../../kit/components/health-line";
import {
  ASSIST_RETURN_URL,
  classifyAuthSession,
  reconnectFailureMessage,
} from "../../lib/connection-reauth";
import {
  beginConnectionAuthorization,
  completeConnectionAuthorization,
  listConnections,
  setConnectionStatus,
} from "../../lib/connections";
import type { ConnectionEntry } from "../../lib/connections";
import { resolveGatewayBase } from "../../lib/gateway";
import { opsStateFor } from "./connectors-model";
import type { ConnectorAct, ConnectorFilter } from "./connectors-model";

/** How often the page re-reads health while it is open (Approvals' cadence). */
const POLL_MS = 60_000;

/** What the gateway answered. `empty`/`full` are derived, never stored. */
export type ConnectorsLoad =
  | { kind: "loading" }
  /** `at` is when the answer landed. Every "4 minutes ago" on the page is
   *  measured from it rather than from `Date.now()` at render time: a clock
   *  read during render is impure (the compiler says so), and a row that
   *  silently re-ages on an unrelated re-render is claiming a freshness
   *  nothing re-checked. */
  | { at: number; kind: "ready"; connections: ConnectionEntry[] }
  /** `reason` is the underlying failure, shown as the error panel's one fact —
   *  the panel's own body never changes, because what is safe does not. */
  | { kind: "error"; reason: string };

export interface ConnectorsController {
  load: ConnectorsLoad;
  state: OpsState;
  connections: readonly ConnectionEntry[];
  /** The clock every relative phrase on the page is measured from. */
  now: number;
  filter: ConnectorFilter;
  setFilter: (next: ConnectorFilter) => void;
  refreshing: boolean;
  actionError: string | undefined;
  refresh: () => Promise<void>;
  retry: () => void;
  perform: (connectionId: string, act: ConnectorAct) => void;
}

const NOT_PAIRED = "This phone is not paired with a gateway yet.";

function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The gateway did not answer.";
}

async function read(apply: (next: ConnectorsLoad) => void): Promise<void> {
  try {
    if (!(await resolveGatewayBase())) {
      apply({ kind: "error", reason: NOT_PAIRED });
      return;
    }
    const connections = await listConnections();
    apply({ at: Date.now(), connections, kind: "ready" });
  } catch (error) {
    apply({ kind: "error", reason: describe(error) });
  }
}

/** Run the OAuth ceremony for one lapsed connection, in-app. */
async function reauthorize(connectionId: string): Promise<void> {
  const authUrl = await beginConnectionAuthorization(connectionId);
  const outcome = classifyAuthSession(
    await WebBrowser.openAuthSessionAsync(authUrl, ASSIST_RETURN_URL)
  );
  const failure = reconnectFailureMessage(outcome);
  if (failure) throw new Error(failure);
  if (outcome.kind === "assist-handoff")
    await completeConnectionAuthorization(outcome.handoff);
  // `closed` needs nothing: a BYO ceremony finishes at the gateway's own
  // callback page, and the caller re-reads either way — a connection that was
  // authorized stops saying `Needs re-auth` on its own.
}

export function useConnectors(): ConnectorsController {
  const [load, setLoad] = useState<ConnectorsLoad>({ kind: "loading" });
  const [filter, setFilter] = useState<ConnectorFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  // A ref, not state: the guard has to hold WITHIN a tick. Two taps on
  // `Re-authorize` before React re-renders would otherwise open two consent
  // ceremonies, and the gateway binds a pending ceremony to one client
  // session — the second would strand the first.
  const inFlight = useRef(false);

  useEffect(() => {
    void read(setLoad);
    const timer = setInterval(() => void read(setLoad), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setActionError(undefined);
    await read(setLoad);
    setRefreshing(false);
  }, []);

  const retry = useCallback((): void => {
    setLoad({ kind: "loading" });
    setActionError(undefined);
    void read(setLoad);
  }, []);

  const perform = useCallback(
    (connectionId: string, act: ConnectorAct): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      void (async (): Promise<void> => {
        setActionError(undefined);
        try {
          if (act === "reauthorize") await reauthorize(connectionId);
          else
            await setConnectionStatus(
              connectionId,
              act === "resume" ? "active" : "paused"
            );
          await read(setLoad);
        } catch (error) {
          setActionError(describe(error));
        } finally {
          inFlight.current = false;
        }
      })();
    },
    []
  );

  const connections = load.kind === "ready" ? load.connections : [];
  // Nothing that is not `ready` shows a time, so the epoch is a fine stand-in
  // — and it keeps the clock out of the render path entirely.
  const now = load.kind === "ready" ? load.at : 0;
  const state = useMemo(
    () =>
      opsStateFor(
        load.kind === "ready" ? "ready" : load.kind,
        connections.length
      ),
    [load.kind, connections.length]
  );

  return {
    actionError,
    connections,
    filter,
    load,
    now,
    perform,
    refresh,
    refreshing,
    retry,
    setFilter,
    state,
  };
}
