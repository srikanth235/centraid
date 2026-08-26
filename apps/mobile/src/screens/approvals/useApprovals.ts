// The Notifications place's data half (#765): read (`getNotifications(true)`),
// SSE doorbell, poll, push permission, replica wake, and all five writes —
// all load-bearing. Standing grants ride here too (`/centraid/_vault/
// outbox-grants`, #308): a gateway without them leaves the section absent
// rather than failing the page — the queue is what the page is FOR.

import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpsState } from "../../kit/components/health-line";
import {
  ASSIST_RETURN_URL,
  classifyAuthSession,
  reconnectFailureMessage,
} from "../../lib/connection-reauth";
import {
  apiHeaders,
  beginNotificationsConnectionAuthorization,
  completeNotificationsConnectionAuthorization,
  confirmParked,
  decideNotificationsOutbox,
  decideNotificationsScope,
  fetchJson,
  getNotifications,
  requireGatewayBase,
  resolveGatewayBase,
  subscribeMobileNotificationsChanges,
  updateMobileNotice,
} from "../../lib/gateway";
import type { MobileNotifications } from "../../lib/gateway";
import { requestNotificationPermission } from "../../lib/notifications-core";
import { registerReplicaPushWake } from "../../lib/replica/background-sync";
import { NOT_PAIRED, opsStateFor, waitingTotal } from "./approvals-model";
import type { OutboxGrant } from "./approvals-model";

/** How often the page re-reads while it is open, between doorbells. */
const POLL_MS = 60_000;

export type ApprovalsLoad =
  | { kind: "loading" }
  /** `at` anchors every relative phrase — never a render-time clock read. */
  | {
      at: number;
      kind: "ready";
      data: MobileNotifications;
      grants: OutboxGrant[];
    }
  /** `reason` is the error panel's one fact; its body never changes. */
  | { kind: "error"; reason: string; unpaired: boolean };

export interface ApprovalsController {
  load: ApprovalsLoad;
  state: OpsState;
  data: MobileNotifications | undefined;
  grants: readonly OutboxGrant[];
  now: number;
  waiting: number;
  refreshing: boolean;
  /** Id of the decision mid-flight; its verb is withdrawn. */
  busyId: string | undefined;
  actionError: string | undefined;
  refresh: () => Promise<void>;
  retry: () => void;
  /** Run one write, then re-read. Never patches a row in place: what is
   *  waiting is the gateway's to report. */
  act: (id: string, write: () => Promise<void>) => void;
  approveOutbox: (
    itemId: string,
    alwaysAllow: boolean,
    artifact?: Record<string, unknown>
  ) => void;
  denyOutbox: (itemId: string) => void;
  confirmParkedInvocation: (invocationId: string, approve: boolean) => void;
  decideScope: (requestId: string, approve: boolean) => void;
  readNotice: (noticeId: string) => void;
  archiveNotice: (noticeId: string) => void;
  reconnect: (connectionId: string) => void;
  revokeGrant: (grantId: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The gateway did not answer.";
}

/** Standing grants, or none — never an exception that takes the queue down. */
async function readGrants(): Promise<OutboxGrant[]> {
  try {
    const base = await requireGatewayBase();
    const body = await fetchJson<{ grants?: OutboxGrant[] }>(
      `${base}/centraid/_vault/outbox-grants`,
      { headers: apiHeaders(), method: "GET" }
    );
    return body.grants ?? [];
  } catch {
    return [];
  }
}

async function read(apply: (next: ApprovalsLoad) => void): Promise<void> {
  try {
    if (!(await resolveGatewayBase())) {
      apply({ kind: "error", reason: NOT_PAIRED, unpaired: true });
      return;
    }
    // Archived notices ride the same read; their section needs no second fetch.
    const data = await getNotifications(true);
    apply({ at: Date.now(), data, grants: await readGrants(), kind: "ready" });
  } catch (error) {
    apply({ kind: "error", reason: describe(error), unpaired: false });
  }
}

/** In-app reconnection: the host app must stay active so the phone-local
 *  tunnel serves the gateway's OAuth callback and the Assist return resolves
 *  into THIS process. See `lib/connection-reauth.ts`. */
async function reauthorize(connectionId: string): Promise<void> {
  const authUrl = await beginNotificationsConnectionAuthorization(connectionId);
  const outcome = classifyAuthSession(
    await WebBrowser.openAuthSessionAsync(authUrl, ASSIST_RETURN_URL)
  );
  const failure = reconnectFailureMessage(outcome);
  if (failure) throw new Error(failure);
  if (outcome.kind === "assist-handoff")
    await completeNotificationsConnectionAuthorization(outcome.handoff);
  // `closed` needs nothing: BYO finishes at the gateway; caller re-reads.
}

async function revoke(grantId: string): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<unknown>(
    `${base}/centraid/_vault/outbox-grants/${encodeURIComponent(grantId)}`,
    { headers: apiHeaders(), method: "DELETE" }
  );
}

export function useApprovals(): ApprovalsController {
  const [load, setLoad] = useState<ApprovalsLoad>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  // A ref, not state: the guard must hold WITHIN a tick — two taps before a
  // re-render would otherwise stage two decisions about one item.
  const inFlight = useRef(false);

  useEffect(() => {
    void read(setLoad);
    void requestNotificationPermission()
      .then(async (granted) => {
        if (!granted) return;
        const base = await resolveGatewayBase();
        if (base) await registerReplicaPushWake(base);
      })
      .catch(() => undefined);
    const controller = new AbortController();
    void subscribeMobileNotificationsChanges(
      () => void read(setLoad),
      controller.signal
    ).catch(() => undefined);
    const timer = setInterval(() => void read(setLoad), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
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

  const act = useCallback((id: string, write: () => Promise<void>): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyId(id);
    setActionError(undefined);
    void (async (): Promise<void> => {
      try {
        await write();
        await read(setLoad);
      } catch (error) {
        setActionError(describe(error));
      } finally {
        inFlight.current = false;
        setBusyId(undefined);
      }
    })();
  }, []);

  const data = load.kind === "ready" ? load.data : undefined;
  const waiting = data ? waitingTotal(data) : 0;
  const state = useMemo(
    () => opsStateFor(load.kind === "ready" ? "ready" : load.kind, waiting),
    [load.kind, waiting]
  );

  return {
    act,
    actionError,
    approveOutbox: (itemId, alwaysAllow, artifact) =>
      act(itemId, () =>
        decideNotificationsOutbox(itemId, "approve", {
          ...(artifact ? { artifact } : {}),
          alwaysAllow,
        })
      ),
    archiveNotice: (noticeId) =>
      act(noticeId, () => updateMobileNotice(noticeId, "archive")),
    busyId,
    confirmParkedInvocation: (invocationId, approve) =>
      act(invocationId, () => confirmParked(invocationId, approve)),
    data,
    decideScope: (requestId, approve) =>
      act(requestId, () => decideNotificationsScope(requestId, approve)),
    denyOutbox: (itemId) =>
      act(itemId, () => decideNotificationsOutbox(itemId, "discard")),
    grants: load.kind === "ready" ? load.grants : [],
    load,
    // Nothing not `ready` shows a time; epoch keeps clocks out of render.
    now: load.kind === "ready" ? load.at : 0,
    readNotice: (noticeId) =>
      act(noticeId, () => updateMobileNotice(noticeId, "read")),
    reconnect: (connectionId) =>
      act(connectionId, () => reauthorize(connectionId)),
    refresh,
    refreshing,
    retry,
    revokeGrant: (grantId) => act(grantId, () => revoke(grantId)),
    state,
    waiting,
  };
}
