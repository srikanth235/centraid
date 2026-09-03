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

const POLL_MS = 60_000;

export type ConnectorsLoad =
  | { kind: "loading" }
  | { at: number; kind: "ready"; connections: ConnectionEntry[] }
  | { kind: "error"; reason: string };

export interface ConnectorsController {
  load: ConnectorsLoad;
  state: OpsState;
  connections: readonly ConnectionEntry[];
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

async function reauthorize(connectionId: string): Promise<void> {
  const authUrl = await beginConnectionAuthorization(connectionId);
  const outcome = classifyAuthSession(
    await WebBrowser.openAuthSessionAsync(authUrl, ASSIST_RETURN_URL)
  );
  const failure = reconnectFailureMessage(outcome);
  if (failure) throw new Error(failure);
  if (outcome.kind === "assist-handoff")
    await completeConnectionAuthorization(outcome.handoff);
}

export function useConnectors(): ConnectorsController {
  const [load, setLoad] = useState<ConnectorsLoad>({ kind: "loading" });
  const [filter, setFilter] = useState<ConnectorFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
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
