// Shared harness for the renderer gateway contract tests: the stubbed
// `window.CentraidApi` + `fetch`, the path-routing mock gateway that fails
// closed on an unrouted path (#541), and the per-test reset. The client modules
// are imported *after* the globals are stubbed, which is why this module
// top-level-awaits them rather than importing them statically. Test-only module
// — imported by gateway-client-automations.contract.test.ts /
// gateway-client-vault.contract.test.ts, never shipped.

import { beforeEach, vi } from "vitest";
import type { Mock } from "vitest";

// Annotated rather than inferred. Under vitest 4 the inferred `vi.fn()` type
// names `@vitest/spy` through its install path, which declaration emit rejects
// as non-portable (TS2742) — `tsc --noEmit` never sees it, so this only breaks
// the package build. Naming `Mock` from 'vitest' keeps the emitted `.d.ts`
// pointing at a real specifier, and sourcing both signatures from what they
// stand in for keeps them honest.
export const getGatewayAuth: Mock<typeof window.CentraidApi.getGatewayAuth> =
  vi.fn();
export const fetchMock: Mock<typeof responseFor> = vi.fn();

/**
 * Per-test toggles the mock gateway reads. `installGatewayContractHarness()`
 * restores both defaults before every test.
 */
export const state = { hostAppSessions: false, forceVault404: false };

export function json(
  body: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function stream(frames: string, headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    }),
    { status: 200, headers }
  );
}

export function row(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest["triggers"] = [
    { kind: "cron", expr: "0 9 * * *" },
  ];
  return {
    id: "daily",
    dir: "/apps/daily",
    name: "Daily",
    triggers,
    enabled: true,
    ownerApp: "daily",
    ref: "daily/daily",
    manifest: {
      name: "Daily",
      version: "0.1.0",
      enabled: true,
      prompt: "Run daily.",
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: "agent", at: "2026-07-25T00:00:00.000Z" },
    },
  };
}

/** A ledger item whose `kind` is an actual member of the pinned union. */
export function item(): CentraidAutomationItem {
  return {
    itemId: "item-1",
    turnId: "turn-1",
    kind: "step",
    ordinal: 0,
    startedAt: 1,
    ok: true,
  } as CentraidAutomationItem;
}

export function responseFor(rawUrl: string, init?: RequestInit): Response {
  const url = new URL(rawUrl);
  const path = `${url.pathname}${url.search}`;
  const method = init?.method ?? "GET";

  if (path === "/centraid/_gateway/info")
    return json({
      capabilities: {
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: true,
        automationTurns: true,
      },
    });
  if (path.includes("/web-session"))
    return json({ launchPath: "/centraid/_web/session/launch-1" });
  if (path.includes("/git-versions"))
    return json({
      versions: [
        {
          tag: "v2",
          version: 2,
          sha: "abc",
          uploadedAt: "2026-07-25T00:00:00.000Z",
          active: true,
        },
      ],
    });
  if (path.endsWith("/rollback")) return json({ id: "daily", sha: "abc" });
  if (path.endsWith("/logs") || path.includes("/logs?"))
    return json({
      entries: [
        { ts: 1, level: "info", source: "query", handler: "list", msg: "ok" },
      ],
    });
  if (path.endsWith("/settings"))
    return json({ settings: { timezone: "UTC" } });
  if (path === "/centraid/_apps" && method === "GET")
    return json([{ id: "daily", hasIndex: true }]);
  if (path === "/centraid/_templates") return json([]);
  if (path === "/_centraid-user/id") return json({ id: "user-1" });
  if (path === "/_centraid-user/prefs")
    return json({ prefs: { runner: "codex" } });
  if (path === "/centraid/_apps/_sessions" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { sessionId: string };
    return json({ sessionId: body.sessionId });
  }
  if (path === "/centraid/_automations" && method === "GET")
    return json({ rows: [row()] });
  if (path === "/centraid/_automations" && method === "POST")
    return json({
      row: row(),
      webhook: {
        id: "hook-1",
        secret: "secret-1",
        url: "https://gateway.test/hook-1",
      },
    });
  if (path.startsWith("/centraid/_automations/read"))
    return json({ row: row() });
  if (path.startsWith("/centraid/_automations/update"))
    return json({
      row: row(),
      webhook: {
        id: "hook-1",
        secret: "secret-2",
        url: "https://gateway.test/hook-1",
      },
    });
  if (path.startsWith("/centraid/_automations/rotate-webhook"))
    return json({
      webhook: {
        id: "hook-1",
        secret: "secret-3",
        url: "https://gateway.test/hook-1",
      },
    });
  if (path.startsWith("/centraid/_automations/turn-now"))
    return json({ turnId: "turn-1" });
  if (path.startsWith("/centraid/_automations/turns"))
    return json({
      turns: [{ turnId: "turn-1", startedAt: 1, endedAt: 2, ok: true }],
    });
  if (path.startsWith("/centraid/_automations/turn/items"))
    return json({ items: [item()] });
  if (path.startsWith("/centraid/_automations/turn/events"))
    return stream(
      'data: not-json\n\ndata: {"missing":"type"}\n\ndata: {"type":"turn.end","turnId":"turn-1","ok":true}\n\n'
    );
  if (path.startsWith("/centraid/_automations/turn?") && method === "POST")
    return stream(
      'event: final\ndata: {"type":"final","text":"done"}\n\nevent: end\ndata: {}\n\n',
      { "x-centraid-turn-id": "turn-2" }
    );
  if (path.startsWith("/centraid/_automations/turn?"))
    return json({
      turn: { turnId: "turn-1", startedAt: 1, endedAt: 2, ok: true },
      items: [item()],
    });
  if (path.startsWith("/centraid/_automations/source"))
    return json({ manifest: '{"name":"Daily"}', handler: "export default {}" });
  if (path.startsWith("/centraid/_automations/compile"))
    return json({ compileTurnId: "compile-1" });
  if (path.startsWith("/centraid/_automations/revise"))
    return json({ compileTurnId: "compile-2" });
  if (path.startsWith("/centraid/_automations/turn/pin"))
    return json({ ok: true });
  if (path.startsWith("/centraid/_automations/set-enabled"))
    return json({ ok: true });
  if (path.startsWith("/centraid/_automations?") && method === "DELETE")
    return json({ deletedApp: true });
  if (path.startsWith("/centraid/_insights/summary"))
    return json({ totals: {} });
  if (path === "/centraid/_gateway/health")
    return json({ status: "ok", components: [] });
  if (path === "/centraid/_gateway/resource/pause")
    return method === "DELETE"
      ? json({ paused: false })
      : json({ paused: true, until: "2026-07-25T01:00:00.000Z" });

  if (path === "/centraid/_vault/status")
    return state.forceVault404
      ? new Response(null, { status: 404 })
      : json({
          vaultId: "vault-1",
          name: "Home",
          ownerPartyId: "party-1",
          fresh: false,
        });
  if (path === "/centraid/_vault/vaults")
    return state.forceVault404
      ? new Response(null, { status: 404 })
      : json({
          vaults: [
            { vaultId: "vault-1", name: "Home", ownerPartyId: "party-1" },
          ],
        });
  if (path.startsWith("/centraid/_vault/vaults/"))
    return json({
      vaultId: "vault-1",
      name: "Renamed",
      ownerPartyId: "party-1",
    });
  if (path === "/centraid/_vault/agents") return json({ agents: [] });
  if (path === "/centraid/_vault/entities")
    return json({ entities: ["business.invoice"] });
  if (path.startsWith("/centraid/_vault/picker")) return json({ cards: [] });
  if (path.startsWith("/centraid/_vault/anchors")) return json({ anchors: [] });
  if (path === "/centraid/_vault/apps") return json({ apps: [] });
  if (path.includes("/grants") && method === "POST")
    return json({ grantId: "grant-1" });
  if (path.startsWith("/centraid/_vault/grants/"))
    return json({ viewsRevoked: 1, parkedDropped: 1 });
  if (path === "/centraid/_vault/parked") return json({ parked: [] });
  if (path.startsWith("/centraid/_vault/parked/"))
    return json({ status: "executed" });
  if (path === "/centraid/_vault/demo") return json({ apps: [] });
  if (path.startsWith("/centraid/_vault/demo/")) return json({ rows: 3 });
  if (path === "/centraid/_vault/imports" && method === "POST")
    return json({
      batchId: "batch-1",
      kind: "csv",
      staged: { invoice: 1 },
      total: 1,
      unrouted: [],
    });
  if (path === "/centraid/_vault/imports" && method === "GET")
    return json({ batches: [] });
  if (path.endsWith("/publish"))
    return json({ created: 1, updated: 0, skipped: 0, failed: [] });
  if (path.endsWith("/discard")) return json({ receiptId: "receipt-1" });
  if (path === "/centraid/_vault/imports/connections")
    return json({ connections: [] });
  if (path.includes("/imports/connections/")) return json({ ok: true });
  if (path.startsWith("/centraid/_vault/imports/")) return json({ rows: [] });

  if (path === "/centraid/_vault/blocking")
    return json({ outbox: [], needsAuth: [], parked: [], scopeRequests: [] });
  if (path.startsWith("/centraid/_vault/review")) return json({ entries: [] });
  if (
    path.startsWith("/centraid/_vault/outbox?") ||
    path === "/centraid/_vault/outbox"
  )
    return json({ items: [] });
  if (path.startsWith("/centraid/_vault/outbox/"))
    return json({ status: "executed", item_id: "item-1" }, 409);
  if (path === "/centraid/_vault/outbox-grants") return json({ grants: [] });
  if (path.startsWith("/centraid/_vault/outbox-grants/"))
    return json({ status: "revoked", grant_id: "grant-1" }, 409);
  if (path === "/centraid/_vault/scope-requests") return json({ requests: [] });
  if (path.startsWith("/centraid/_vault/scope-requests/"))
    return json({ request: { requestId: "scope-1" }, approved: true });

  if (path.startsWith("/centraid/_logs/events"))
    return stream(
      'data: nope\n\ndata: {"seq":"bad","message":"skip"}\n\ndata: {"seq":2,"ts":1,"level":"info","message":"ready"}\n\n'
    );
  if (path.startsWith("/centraid/_logs"))
    return json({
      entries: [{ seq: 1, ts: 1, level: "info", message: "booted" }],
    });
  if (path.startsWith("/centraid/_apps/") && method === "DELETE")
    return json({ id: "daily" });

  // Fail closed. A blanket `{ ok: true }` made this a contract test that
  // could not fail: a client calling a renamed or misspelled path still
  // resolved and passed. An unrouted path is a broken contract (#541).
  throw new Error(`unrouted gateway path: ${method} ${path}`);
}

window.CentraidApi = {
  getGatewayAuth,
  getHostCapabilities: async () => ({ appSessions: state.hostAppSessions }),
  onGatewayChanged: () => () => undefined,
  onVaultChanged: () => () => undefined,
} as unknown as typeof window.CentraidApi;
vi.stubGlobal("fetch", fetchMock);

export const client = await import("./gateway-client.js");
export const vault = await import("./gateway-client-vault.js");
export const editing = await import("./gateway-client-automation-editing.js");
export const outbox = await import("./gateway-client-outbox.js");
export const logs = await import("./gateway-client-logs.js");
export const compile = await import("./gateway-client-automation-compile.js");
const { resetGatewayAuthCache } = await import("./gateway-client-core.js");
const { resetAppSessions } = await import("./gateway-client-editing.js");

/** Registers the per-test reset. Call once at the top level of a test file. */
export function installGatewayContractHarness(): void {
  beforeEach(() => {
    state.hostAppSessions = false;
    state.forceVault404 = false;
    getGatewayAuth.mockReset().mockResolvedValue({
      baseUrl: "https://gateway.test",
      gatewayId: "gateway-1",
      token: "token-1",
      vaultId: "vault-1",
    });
    fetchMock.mockReset().mockImplementation(responseFor);
    resetGatewayAuthCache();
    resetAppSessions();
  });
}
