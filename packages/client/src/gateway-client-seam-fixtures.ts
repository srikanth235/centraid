/*
 * Shared harness for the client↔gateway SEAM contract tests (#656 Layer 1B):
 * the storage, backup, atlas, owners, devices, conversation-history and
 * app-editing wire surfaces that had no test file at all.
 *
 * Same shape as `gateway-client-contract-fixtures.ts` — stub `window.CentraidApi`
 * and `fetch` first, import the client modules after — but with a *recording*
 * transport instead of a bare path router, because the laws these tests state
 * are about the request (method, route, headers, body) as much as the reply.
 * Kept a second harness rather than growing the first: the two mock gateways
 * would together blow the repo's file-size cap, and each test file loads its
 * own module graph under vitest anyway.
 *
 * Fails closed on an unrouted path (#541): a client that renames or misspells
 * a route must not quietly resolve.
 *
 * Test-only module — imported by the `*.contract.test.ts` files beside it,
 * never shipped.
 */

import { beforeEach, vi } from "vitest";
import type { Mock } from "vitest";

/** One recorded outbound request, decomposed the way the laws assert on it. */
export interface SeamRequest {
  method: string;
  /** Path only — the query lives in {@link SeamRequest.query}. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** Raw body as handed to `fetch` (a string for JSON routes, a File for uploads). */
  body: BodyInit | null | undefined;
}

/** Every request the client made since the harness' `beforeEach` reset. */
export const requests: SeamRequest[] = [];

type Responder = (request: SeamRequest) => Response | Promise<Response>;

const overrides: Array<{ key: string; responder: Responder }> = [];

/**
 * Override (or add) one route for the current test. `key` is `"<METHOD> <path>"`;
 * the newest registration for a key wins, so a test can restate an outcome the
 * default gateway already routes.
 */
export function respond(key: string, responder: Responder): void {
  overrides.unshift({ key, responder });
}

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

/** The JSON body of the single request matching `key`. Throws if there isn't exactly one. */
export function sentJson(key: string): Record<string, unknown> {
  const matches = requests.filter((r) => `${r.method} ${r.path}` === key);
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${key}, saw ${matches.length}`);
  return JSON.parse(String(matches[0]?.body)) as Record<string, unknown>;
}

/** The single request matching `key`. Throws if there isn't exactly one. */
export function sent(key: string): SeamRequest {
  const matches = requests.filter((r) => `${r.method} ${r.path}` === key);
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${key}, saw ${matches.length}`);
  return matches[0] as SeamRequest;
}

/** `"<METHOD> <path>"` for every recorded request, in order. */
export function wireLog(): string[] {
  return requests.map((r) => `${r.method} ${r.path}`);
}

const CONNECTION = {
  id: "conn-1",
  kind: "provider" as const,
  name: "Home",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
  baseUrl: "https://provider.test",
};

const BACKUP_POLICY = {
  rpoSeconds: 900,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  casAck: "receipt" as const,
  outboxBudgetBytes: 1024,
  reservedHeadroomBytes: 512,
  walBaseRollBytes: 2048,
  walBaseRollHours: 12,
};

/** The default mock gateway: canonical happy-path replies, keyed by method+path. */
const ROUTES: Record<string, Responder> = {
  // ── storage connections (#367 §C1/§D, #436) ──
  "GET /centraid/_gateway/storage/connections": () =>
    json({ connections: [CONNECTION] }),
  "POST /centraid/_gateway/storage/connections": () =>
    json({ connection: CONNECTION }),
  "PATCH /centraid/_gateway/storage/connections/conn-1": () =>
    json({ connection: { ...CONNECTION, name: "Renamed" } }),
  "DELETE /centraid/_gateway/storage/connections/conn-1": () => json({}),
  "POST /centraid/_gateway/storage/connections/conn-1/test": () =>
    json({ ok: true, detail: "HEAD 200" }),
  "GET /centraid/_gateway/storage/status": () => json({ vaults: [] }),
  "GET /centraid/_gateway/storage/usage": () => json({ connections: [] }),
  "GET /centraid/_gateway/storage/status/events": () =>
    stream(
      'data: not-json\n\ndata: {"vaults":"nope"}\n\ndata: {"vaults":[{"vaultId":"vault-1"}]}\n\n'
    ),
  "GET /centraid/_vault/blob-store": () => json({ blob_store: { kind: "fs" } }),
  "PUT /centraid/_vault/blob-store": (request) =>
    json({ blob_store: JSON.parse(String(request.body)).blob_store }),

  // ── enrichment tier (the owner's per-domain consent, #352 / S9) ──
  // The PUT echoes the MERGED state, not the patch: the real route reads the
  // vault back after writing, and a client that rendered its own patch would
  // show a tier the vault may never have accepted.
  "GET /centraid/_vault/enrich": () =>
    json({
      enrich: { photos: "gateway", docs: "gateway" },
      // Additive since #807: the cascade's scoped rules ride alongside the
      // tiers, and a client that reads only `enrich` is unaffected.
      rules: [
        {
          scope: { type: "domain", ref: "photos" },
          capability: "ocr",
          enabled: null,
          profile: null,
          trigger: "on-view",
          updatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
    }),
  "PUT /centraid/_vault/enrich/rules": (request) =>
    json({
      rule: {
        scope: {
          type: (JSON.parse(String(request.body)) as { scope: string }).scope,
          ref: (JSON.parse(String(request.body)) as { ref?: string }).ref ?? "",
        },
        capability: "ocr",
        enabled: null,
        profile: null,
        trigger: "on-demand",
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    }),
  "DELETE /centraid/_vault/enrich/rules": () => json({ deleted: true }),
  "GET /centraid/_vault/enrich/effective": () =>
    json({
      tier: "device",
      rules: [],
      effective: {
        capability: "ocr",
        enabled: true,
        profileId: "built-in",
        trigger: "on-ingest",
        egressCeiling: "on-device",
      },
    }),
  // The egress-consent ledger (#807). The POST answers with the row the
  // VAULT holds — the route reads it back after the one writer wrote it.
  "GET /centraid/_vault/enrich/consent": () =>
    json({
      consent: [
        {
          capability: "faces",
          egress: "provider",
          scopeRef: "",
          decision: "declined",
          decidedAt: "2026-08-15T10:00:00.000Z",
          receiptId: null,
        },
      ],
    }),
  "POST /centraid/_vault/enrich/consent": (request) =>
    json({
      consent: {
        ...(JSON.parse(String(request.body)) as Record<string, unknown>),
        scopeRef: "",
        decidedAt: "2026-08-16T00:00:00.000Z",
        receiptId: null,
      },
    }),
  "PUT /centraid/_vault/enrich": (request) =>
    json({
      enrich: {
        docs: "gateway",
        photos: "gateway",
        ...(JSON.parse(String(request.body)) as Record<string, unknown>),
      },
    }),

  // ── backup engine (#351 / #436) ──
  "GET /centraid/_gateway/backup": () =>
    json({
      configured: true,
      vaults: [
        {
          vaultId: "vault-1",
          policy: BACKUP_POLICY,
          destination: { kind: "provider", connectionId: "conn-1" },
          pendingOffsite: { count: 0, bytes: 0 },
        },
      ],
      recoveryKit: { confirmedAt: null },
    }),
  "PUT /centraid/_gateway/backup/policy/vault-1": () =>
    json({ vaultId: "vault-1", policy: BACKUP_POLICY }),
  "POST /centraid/_gateway/backup/run": () => json({ accepted: true }, 202),
  "POST /centraid/_gateway/backup/verify": () => json({ accepted: true }, 202),
  "POST /centraid/_gateway/backup/verify-bucket/vault-1": () =>
    json({ vaultId: "vault-1", reconciliation: { status: "ok" } }),
  "POST /centraid/_gateway/backup/kit-confirmed": () =>
    json({ ok: true, confirmedAt: 1_700_000_000 }),

  // ── vault atlas + browse (#441) ──
  "GET /centraid/_vault/atlas/stats": () =>
    json({ method: "dbstat", packs: [], totals: { rows: 0 } }),
  "GET /centraid/_vault/atlas/graph": () =>
    json({ center: "core_party", nodes: [], fkEdges: [] }),
  "GET /centraid/_vault/atlas/pulse": () => json({ live: true, series: [] }),
  "GET /centraid/_vault/atlas/browse/tables": () =>
    json({ tables: [{ logical: "core.party", rows: 3 }] }),
  "GET /centraid/_vault/atlas/browse/columns": () =>
    json({ logical: "core.party", columns: [] }),
  "GET /centraid/_vault/atlas/browse/rows": () =>
    json({ rows: [], nextCursor: null }),
  "GET /centraid/_vault/atlas/browse/row": () =>
    json({ logical: "core.party", row: { id: "p1" } }),
  "GET /centraid/_vault/atlas/browse/ref-search": () =>
    json({ hits: [{ id: "p1", display: "Ada" }] }),
  "GET /centraid/_vault/atlas/browse/dependents": () =>
    json({ id: "p1", dependents: [] }),
  "POST /centraid/_vault/atlas/browse/insert": () =>
    json({ ok: true, id: "p2" }),
  "POST /centraid/_vault/atlas/browse/update": () => json({ ok: true }),
  "POST /centraid/_vault/atlas/browse/delete": () => json({ ok: true }),
  "DELETE /centraid/_vault/demo": () => json({ purged: 3, blocked: [] }),
  "DELETE /centraid/_vault/demo/daily": () => json({ purged: 1, blocked: [] }),

  // ── owner surface (#726) ──
  "GET /centraid/_gateway/owners": () =>
    json({
      owners: [
        {
          ownerId: "o-1",
          label: "Ada",
          createdAt: "2026-07-25T00:00:00.000Z",
          vaults: [],
          deviceCount: 2,
        },
      ],
    }),
  "PATCH /centraid/_gateway/owners/o-1": (request) =>
    json({ owner: { ownerId: "o-1", ...JSON.parse(String(request.body)) } }),

  // ── pairing-ticket mint, self-pair + "Add someone" (#726, #726 P1) ──
  "POST /centraid/_gateway/devices/ticket": (request) => {
    const body = JSON.parse(String(request.body)) as {
      forPerson?: { label: string; vaultName?: string };
    };
    if (body.forPerson) {
      return json({
        ok: true,
        ticket: "CENTRAID-TICKET-PERSON",
        ownerId: "o-new",
        ownerLabel: body.forPerson.label,
        vaults: [{ vaultId: "v-new", vaultName: body.forPerson.vaultName }],
        vaultId: "v-new",
        vaultName: body.forPerson.vaultName,
        expiresAt: "2026-07-25T01:00:00.000Z",
      });
    }
    return json({
      ok: true,
      ticket: "CENTRAID-TICKET-SELF",
      ownerId: "o-1",
      ownerLabel: "Ada",
      vaults: [{ vaultId: "vault-1", vaultName: "Personal" }],
      vaultId: "vault-1",
      vaultName: "Personal",
      expiresAt: "2026-07-25T01:00:00.000Z",
    });
  },

  // ── commons steward-absence recovery (#731 presence, #750 surface) ──
  // The GET answers the vault's whole commons observability record; the client
  // reads the `grants` array out of it and nothing else.
  "GET /centraid/_gateway/commons/recovery": () =>
    json({
      vaultId: "vault-1",
      deviceLinkAt: "2026-08-12T00:00:00.000Z",
      grants: [
        {
          grantId: "grant-1",
          containerType: "album",
          steward: {
            grantId: "grant-1",
            presence: "absent",
            stewardVaultId: "vault-gone",
            silentForMs: 9 * 24 * 60 * 60 * 1000,
            consecutiveFailures: 12,
            lastOutcome: "unreachable",
          },
        },
      ],
    }),
  "POST /centraid/_gateway/commons/recovery": () =>
    json({
      state: "recovered",
      grantId: "grant-2",
      circleId: "circle-1",
      containerType: "album",
      containerId: "album-1",
      invitedPartyIds: ["party-b", "party-c"],
      replayed: false,
      invitations: [
        { partyId: "party-b", memberVaultId: "vault-b", state: "delivered" },
        { partyId: "party-c", state: "claim" },
      ],
    }),

  // ── conversation history (#420 / #599 Decision 14) ──
  "GET /_centraid-conversations/apps/daily/sessions": () =>
    json({ sessions: [{ sessionId: "s-1", title: "First" }] }),
  "POST /_centraid-conversations/apps/daily/sessions": () =>
    json({ sessionId: "s-2", title: "" }),
  "GET /_centraid-conversations/apps/daily/sessions/search": () =>
    json({ results: [{ sessionId: "s-1", snippet: "…milk…" }] }),
  "GET /_centraid-conversations/apps/daily/sessions/s-1": () =>
    json({ sessionId: "s-1", messages: [] }),
  "PATCH /_centraid-conversations/apps/daily/sessions/s-1": () => json({}),
  "DELETE /_centraid-conversations/apps/daily/sessions/s-1": () => json({}),
  "PATCH /_centraid-conversations/apps/daily/sessions/s-1/turns/t-1/feedback":
    () => json({}),
  "GET /_centraid-conversations/apps/daily/blobs/abc": () =>
    new Response("PNGBYTES", {
      status: 200,
      headers: { "content-type": "image/png" },
    }),

  // ── app editing + lifecycle (#141 Phase 2/4, #434, #599) ──
  "POST /centraid/_apps/_sessions": (request) =>
    json({ sessionId: JSON.parse(String(request.body)).sessionId }),
  "DELETE /centraid/_apps/_sessions/desktop-daily": () => json({}),
  "GET /centraid/_draft/desktop-daily/daily/": () =>
    new Response("<html></html>", { status: 200 }),
  "GET /centraid/_apps/daily/files": () =>
    json({ files: [{ path: "app.json", content: "{}" }] }),
  "PUT /centraid/_apps/daily/files/app.json": () =>
    json({ path: "app.json", size: 2 }),
  "POST /centraid/_apps/daily/publish": () =>
    json({ id: "daily", versionTag: "v3", sha: "deadbeef" }),
  "POST /centraid/_apps/daily/reset-data": () =>
    json({ id: "daily", seeded: true, migrationsApplied: [] }),
  "POST /centraid/_apps": () => json({ app: { id: "daily", name: "Daily" } }),
  "POST /centraid/_apps/_clone": () =>
    json({ app: { id: "daily-1" }, template: { id: "daily", name: "Daily" } }),
  "POST /centraid/_apps/_install": () =>
    json({ app: { id: "tally" }, alreadyInstalled: true }),
  "POST /centraid/_apps/daily/meta": () => json({ ok: true }),
  "DELETE /centraid/_apps/daily": () => json({ id: "daily" }),
};

export const getGatewayAuth: Mock<typeof window.CentraidApi.getGatewayAuth> =
  vi.fn();

async function transport(
  rawUrl: string,
  init?: RequestInit
): Promise<Response> {
  const url = new URL(rawUrl);
  const request: SeamRequest = {
    method: init?.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: new Headers(init?.headers as HeadersInit | undefined),
    body: init?.body,
  };
  requests.push(request);
  const key = `${request.method} ${request.path}`;
  const override = overrides.find((entry) => entry.key === key);
  const responder = override?.responder ?? ROUTES[key];
  if (!responder) throw new Error(`unrouted gateway path: ${key}`);
  return responder(request);
}

export const fetchMock: Mock<typeof transport> = vi.fn();

window.CentraidApi = {
  getGatewayAuth,
  getHostCapabilities: async () => ({}),
  onGatewayChanged: () => () => undefined,
  onVaultChanged: () => () => undefined,
} as unknown as typeof window.CentraidApi;
vi.stubGlobal("fetch", fetchMock);

export const storage = await import("./gateway-client-storage.js");
export const backup = await import("./gateway-client-backup.js");
export const atlas = await import("./gateway-client-atlas.js");
export const owners = await import("./gateway-client-owners.js");
export const devices = await import("./gateway-client-devices.js");
export const edges = await import("./gateway-client-edges.js");
export const history = await import("./gateway-client-conversation-history.js");
export const editing = await import("./gateway-client-editing.js");
export const vaultOwner = await import("./gateway-client-vault.js");
const { resetGatewayAuthCache } = await import("./gateway-client-core.js");

/** Registers the per-test reset. Call once at the top level of a test file. */
export function installSeamContractHarness(): void {
  beforeEach(() => {
    requests.length = 0;
    overrides.length = 0;
    getGatewayAuth.mockReset().mockResolvedValue({
      baseUrl: "https://gateway.test",
      gatewayId: "gateway-1",
      token: "token-1",
      vaultId: "vault-1",
    });
    fetchMock.mockReset().mockImplementation(transport);
    resetGatewayAuthCache();
    editing.resetAppSessions();
  });
}
