/*
 * WHAT A SHELL-SESSION SUITE NEEDS BEFORE IT CAN ASSERT ANYTHING (#996, W5).
 *
 * The session reads its identity from the host bridge and opens its outbox on
 * construction, so every suite over it needs the same three things: a stubbed
 * `CentraidApi`, an options bag whose default is the honest one (an outbox and
 * NO COPY of the vault), and an intent to put through it. They live here so
 * the write rail and the storage rail can be separate files without a second
 * copy of the harness drifting from the first.
 */
import { MemoryIntentStore } from "./memory-intent-store.js";
import type * as TypeImport_shellSession from "./shell-session.js";
import type { ReplicaIntent } from "./types.js";

/**
 * The change-cursor key's scope separator — a NUL, written as an escape.
 * A printable separator would collide with an id that contains it.
 */
const SCOPE_SEPARATOR = "\u0000";

/** The host bridge the session asks for its durable identity. */
export function installGatewayApiStub(): void {
  Object.assign(window, {
    CentraidApi: {
      getGatewayAuth: () =>
        Promise.resolve({
          baseUrl: "https://gateway.example",
          gatewayId: "profile-home",
          vaultId: "vault",
          rememberDevice: false,
        }),
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    },
  });
}

export function intent(): ReplicaIntent {
  return {
    intentId: "intent-1",
    payloadHash: "a".repeat(64),
    appId: "todos",
    action: "complete",
    input: { taskId: "task-1" },
    state: "sending",
    createdOrder: 1,
    attempts: 1,
    optimistic: [],
  };
}

export function cursorKey(): string {
  return `centraid:vault-change-cursor:${encodeURIComponent(
    `profile-home${SCOPE_SEPARATOR}vault`
  )}`;
}

/**
 * A session with an outbox and NO COPY of the vault.
 *
 * That is the honest default for a suite with no gateway: the queue is
 * durable from the first write, and every read refuses ONLINE_ONLY. The
 * injected store is the same one the seat file's `outbox()` hands back.
 */
export function options(
  overrides: Partial<
    TypeImport_shellSession.ReplicaShellSessionOptions<TypeImport_shellSession.ReplicaShellSession>
  > = {}
): TypeImport_shellSession.ReplicaShellSessionOptions<TypeImport_shellSession.ReplicaShellSession> {
  return {
    intentStore: new MemoryIntentStore(),
    eventTarget: new EventTarget(),
    isOnline: () => false,
    ...overrides,
  };
}

export function outcomeResponse(
  intentId: string,
  status: string,
  reason?: string
): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 1,
      outcome: { intentId, status, ...(reason ? { reason } : {}) },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
