import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// governance: allow-repo-hygiene file-size-limit — one cohesive e2e harness (mock
// gateway + record builders + DOM helpers) shared by every spec; splitting it would
// scatter the single source of fixture truth. See receipts/issue-225-desktop-e2e-suite.md.
import { _electron, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

import { forEachSequentially } from "@centraid/test-kit/sequential";

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

/*
 * E2E harness for the desktop app. The architecture it mocks:
 *
 *   - App *code* lives in the gateway's git store; the renderer is a thin
 *     HTTP client that talks to the ACTIVE gateway directly (Bearer token).
 *   - `settings.json` carries no gateway URL/token — those are derived from
 *     the active EndpointId-keyed row in the main-process-owned
 *     `<userData>/connections.json`. The Electron test entry maps that
 *     EndpointId to the loopback mock in memory; no URL/token is persisted.
 *   - Apps/automations/turns/templates all come from the gateway over HTTP,
 *     so the mock is the single source of fixture data — `gateway.state` is
 *     mutable and every test shapes it before (or during) the run.
 *
 * Each test owns a fresh tmp `userData`, a fresh mock gateway on a random
 * loopback port, and its own Electron process — state never leaks.
 */

// ─────────────────────────── mock gateway ───────────────────────────

export interface AppMetaEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: "app" | "automation";
}

/** Raw git-store version row (what GET /git-versions returns). */
export interface GitVersion {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  active: boolean;
}

/** A single SSE frame: the JSON object to emit, plus an optional pre-delay (ms). */
export interface SseFrame {
  data: Record<string, unknown>;
  delayMs?: number;
}

export interface MockState {
  /** GET /centraid/_apps */
  apps: AppMetaEntry[];
  /** GET /centraid/_templates */
  templates: Array<Record<string, unknown>>;
  /** GET /centraid/_automations → { rows } */
  automations: Array<Record<string, unknown>>;
  /** GET /centraid/_automations/turns → { turns } (also per-ref) */
  automationTurns: Array<Record<string, unknown>>;
  /** GET /centraid/_automations/turn?turnId= → { turn } */
  automationTurnsById: Record<string, Record<string, unknown>>;
  /** Native items returned by expanded turn reads. */
  automationItemsByTurn: Record<string, Array<Record<string, unknown>>>;
  /** GET /centraid/_apps/:id/git-versions (undefined → 404 = never published) */
  versions: Record<string, GitVersion[]>;
  /** GET /centraid/_apps/:id/logs → { entries } */
  logsById: Record<string, Array<Record<string, unknown>>>;
  /** GET /centraid/_apps/:id/files → { files } */
  filesById: Record<string, Array<{ path: string; content: string }>>;
  /** GET /_centraid-user/prefs → { prefs } */
  prefs: Record<string, unknown>;
  /** GET /centraid/_insights/summary */
  insights: Record<string, unknown>;
  /** GET /centraid/_brief/today (legacy alias: /daily) */
  dailyBrief: Record<string, unknown>;
  /** GET /centraid/_turn/harness-status */
  harnessStatus: Record<string, unknown>;
  /** GET /centraid/_harnesses/status */
  harnessesStatus: Record<string, unknown>;
  /** GET/PUT /centraid/_vault/enrich → `{enrich, rules}` (#807). */
  enrich: Record<string, unknown>;
  /** The cascade's scoped rules, served alongside the tiers above. */
  enrichRules: Array<Record<string, unknown>>;
  /** GET /centraid/_vault/enrich/consent → `{consent}` — answered questions. */
  enrichConsent: Array<Record<string, unknown>>;
  /** GET /centraid/_enrich/profiles → `{profiles}` (engine-profiles.ts). */
  enrichProfiles: Array<Record<string, unknown>>;
  /**
   * GET /centraid/_vault/enrich/effective?domain=&capability= → what the ONE
   * resolver folds, keyed by capability (#814). Settings asks this per
   * capability rather than folding tiers and rules itself, so the mock has to
   * answer it or the page renders its gateway-didn't-answer state.
   */
  enrichEffective: Record<string, Record<string, unknown> | null>;
  /** GET /_centraid-conversations/apps/:appId/sessions → { sessions } */
  conversations: Array<Record<string, unknown>>;
  /** GET /_centraid-conversations/apps/:appId/sessions/:id → messages */
  conversationMessages: Array<Record<string, unknown>>;

  /** Per-method status overrides keyed by a coarse op name. */
  automationsStatus: number; // GET /centraid/_automations (drives the list error card)
  deleteStatus: number; // DELETE /centraid/_apps/:id
  publishStatus: number; // POST /centraid/_apps/:id/publish
  runNowStatus: number; // POST /centraid/_automations/turn-now
  setEnabledStatus: number; // POST /centraid/_automations/set-enabled
  /** When set, EVERY route returns this status (e.g. 401 to drive auth_required). */
  forceStatus?: number;

  /** turnId minted by turn-now + reported on create. */
  nextAutomationTurnId: string;
  /** Result body for clone. */
  cloneResult?: Record<string, unknown>;
  /** Result body for create-app. */
  createAppResult?: Record<string, unknown>;
  /** Result body for create-automation. */
  createAutomationResult?: Record<string, unknown>;

  /** SSE frames for POST /centraid/:appId/_turn */
  turnFrames: SseFrame[];
  /** SSE frames for GET /centraid/_automations/turn/events */
  automationTurnFrames: SseFrame[];

  // ── Household / sharing plane (#781; the reads journey 2.12 needed) ──
  // The desktop's bearer is the host-custody caller, so the mock mirrors the
  // host-custody visibility of each real route: every person, every device,
  // every mounted vault. Shapes mirror the real handlers cited on each field.

  /** GET /centraid/_gateway/owners → `{owners}` (owners-routes.ts `ownerDto`). */
  owners: Array<Record<string, unknown>>;
  /** GET /centraid/_gateway/devices → `{devices}` (devices-routes.ts `DeviceDTO`). */
  devices: Array<Record<string, unknown>>;
  /** GET /centraid/_vault/scopes → `{scopes}` (scopes-routes.ts `ScopeRow`).
   *  `installed` is answered only when the request names `?app=` — "not
   *  asked" and "not installed" are different answers, same as the route. */
  scopes: Array<Record<string, unknown>>;
  /** GET /centraid/_gateway/links → `{links}` (vault-links-routes.ts `linkDto`). */
  links: Array<Record<string, unknown>>;
  /** GET /centraid/_gateway/edges → `{edges}` (edges-routes.ts `edgeWire`).
   *  Same-owner placements only — there is no copy-as-share (#825, ruling
   *  G-copy), so no D9 receive setting and no parked-ask surface. */
  edges: Array<Record<string, unknown>>;
  /** GET /centraid/_gateway/commons/invitations?actorVaultId= → `{invitations}`
   *  (commons-routes.ts / `listCommonsInvitations`), filtered to the asking
   *  vault the way the real route reads one member vault's own rows. */
  commonsInvitations: Array<Record<string, unknown>>;
  /** GET /centraid/_gateway/commons/recovery?actorVaultId= → the
   *  `CommonsVaultObservability` body (commons-recovery-routes.ts →
   *  `commonsObservabilityForVault`): `{vaultId, grants}` keyed per vault. */
  commonsRecovery: Record<string, Array<Record<string, unknown>>>;
  /** GET /centraid/_gateway/device-work/status → `{vaults}` (device-work-
   *  routes.ts) — the roster's queued/leased enrichment depth. The absorb-all
   *  `{}` fallthrough is NOT shape-compatible here: the client reads
   *  `out.vaults`, and an undefined array crashed the whole Household route. */
  deviceWork: Array<Record<string, unknown>>;
}

export interface MockGateway {
  url: string;
  token: string;
  state: MockState;
  /** Calls observed, in arrival order (excludes OPTIONS preflight). */
  calls: Array<{
    method: string;
    pathname: string;
    search: string;
    auth?: string;
    body?: string;
  }>;
  /** Convenience: number of calls matching a method + path predicate. */
  countCalls: (method: string, pathTest: (p: string) => boolean) => number;
  close: () => Promise<void>;
}

interface MockGatewayOptions {
  /** Optional on-disk git-store mirror used by persistence e2e assertions. */
  appsDir?: string;
}

function defaultState(): MockState {
  return {
    apps: [],
    templates: [],
    automations: [],
    automationTurns: [],
    automationTurnsById: {},
    automationItemsByTurn: {},
    versions: {},
    logsById: {},
    filesById: {},
    prefs: {},
    insights: {},
    dailyBrief: {
      date: "2026-07-29",
      events: [],
      tasks: [],
      newPhotos: 0,
      balanceMinor: 0,
      currency: "USD",
    },
    harnessStatus: {
      ok: true,
      kind: "local",
      version: "test",
      models: ["tier-fast", "tier-deep"],
    },
    harnessesStatus: { harnesses: [], models: [] },
    enrich: { photos: "device", docs: "off" },
    enrichRules: [],
    enrichConsent: [],
    enrichProfiles: [],
    enrichEffective: {},
    conversations: [],
    conversationMessages: [],
    automationsStatus: 200,
    deleteStatus: 200,
    publishStatus: 200,
    runNowStatus: 200,
    setEnabledStatus: 200,
    nextAutomationTurnId: "turn-1",
    turnFrames: [],
    automationTurnFrames: [],
    owners: [],
    devices: [],
    scopes: [],
    links: [],
    edges: [],
    commonsInvitations: [],
    commonsRecovery: {},
    deviceWork: [],
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

async function writeSse(
  res: http.ServerResponse,
  frames: SseFrame[]
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS,
  });
  await forEachSequentially(frames, async (f) => {
    if (f.delayMs)
      await new Promise((resolve) => {
        setTimeout(resolve, f.delayMs);
      });
    res.write(`data: ${JSON.stringify(f.data)}\n\n`);
  });
  res.write("event: end\ndata: {}\n\n");
  res.end();
}

export async function startMockGateway(
  options: MockGatewayOptions = {}
): Promise<MockGateway> {
  const state = defaultState();
  if (options.appsDir) {
    const persisted = await readMockApps(options.appsDir);
    state.apps = persisted.apps;
    state.automations = persisted.automations;
  }
  const calls: MockGateway["calls"] = [];
  const token = crypto.randomBytes(16).toString("hex");

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method,
        pathname: p,
        search: url.search,
        auth: req.headers["authorization"] as string | undefined,
        body: body || undefined,
      });

      if (state.forceStatus && state.forceStatus !== 200) {
        json(res, state.forceStatus, { error: "forced" });
        return;
      }

      void route(method, p, url, body, res, state, options).catch(
        (error: unknown) => {
          json(res, 500, { error: String(error) });
        }
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("mock gateway: no address");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    state,
    calls,
    countCalls(m, t) {
      return calls.filter((c) => c.method === m && t(c.pathname)).length;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function route(
  method: string,
  p: string,
  url: URL,
  body: string,
  res: http.ServerResponse,
  s: MockState,
  options: MockGatewayOptions
): Promise<void> {
  const seg = p.split("/").filter(Boolean); // e.g. ['centraid','_apps','todo-abc']

  // The desktop suite exercises the opt-in automation surfaces. Keep that
  // intent explicit in the mock handshake now that the shell reads one
  // capability map before rendering its launcher (C1, #774).
  if (p === "/centraid/_gateway/info" && method === "GET") {
    return json(res, 200, {
      capabilities: {
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: false,
        assistOAuth: false,
        automationTurns: true,
        multiVaultReplica: true,
        crossVaultPlacements: true,
        automations: true,
        connectors: true,
      },
    });
  }

  // ─── editing/session lifecycle (match specific before /:id) ─────
  if (p === "/centraid/_apps/_sessions" && method === "POST") {
    const sid = (() => {
      try {
        return (JSON.parse(body) as { sessionId?: string }).sessionId;
      } catch {
        return undefined;
      }
    })();
    return json(res, 200, { sessionId: sid ?? "desktop-x" });
  }
  if (p.startsWith("/centraid/_apps/_sessions/") && method === "DELETE") {
    return json(res, 200, { ok: true });
  }
  if (p === "/centraid/_apps/_clone" && method === "POST") {
    const result = s.cloneResult ?? defaultCloneResult(body);
    const app = result.app as Partial<AppMetaEntry> | undefined;
    if (app?.id) {
      if (app.kind === "automation") {
        s.automations = [
          ...s.automations.filter((entry) => entry.id !== app.id),
          automationRow({ id: app.id, name: app.name }),
        ];
      } else {
        s.apps = [
          ...s.apps.filter((entry) => entry.id !== app.id),
          appEntry({ ...app, id: app.id }),
        ];
      }
      if (options.appsDir) await writeMockApp(options.appsDir, app.id, app);
    }
    return json(res, 200, result);
  }

  // ─── apps collection ─────
  if (p === "/centraid/_apps") {
    if (method === "GET") return json(res, 200, s.apps);
    if (method === "POST") {
      const parsed = safeJson(body);
      const id = (parsed.id as string) ?? "new-app";
      const result = s.createAppResult ?? {
        app: { id, name: parsed.name, kind: "app" },
      };
      const app = result.app as Partial<AppMetaEntry> | undefined;
      if (app?.id) {
        s.apps = [
          ...s.apps.filter((entry) => entry.id !== app.id),
          appEntry({ ...app, id: app.id }),
        ];
        if (options.appsDir) await writeMockApp(options.appsDir, app.id, app);
      }
      return json(res, 200, result);
    }
  }

  // ─── single app: /centraid/_apps/:id[/...] ─────
  if (seg[0] === "centraid" && seg[1] === "_apps" && seg[2]) {
    const id = decodeURIComponent(seg[2]);
    const sub = seg[3];
    if (!sub) {
      if (method === "DELETE") {
        // Mirror the gateway: a 200 or 404 (already-gone) drops the app from
        // the registry, so a subsequent listApps() won't resurrect the tile.
        // A 5xx leaves it registered. (Offline is modelled by closing the
        // server entirely, so this handler never runs in that case.)
        if (s.deleteStatus === 200 || s.deleteStatus === 404) {
          s.apps = s.apps.filter((a) => a.id !== id);
          if (options.appsDir) {
            await fs.rm(path.join(options.appsDir, id), {
              recursive: true,
              force: true,
            });
          }
        }
        if (s.deleteStatus === 200) return json(res, 200, { id });
        return json(res, s.deleteStatus, {
          error: s.deleteStatus === 404 ? "not_found" : "error",
        });
      }
    }
    if (sub === "logs" && method === "GET")
      return json(res, 200, { entries: s.logsById[id] ?? [] });
    if (sub === "files") {
      if (method === "GET")
        return json(res, 200, { files: s.filesById[id] ?? [] });
      if (method === "PUT")
        return json(res, 200, {
          path: decodeURIComponent(seg[4] ?? ""),
          size: body.length,
        });
    }
    if (sub === "meta" && method === "POST")
      return json(res, 200, { ok: true });
    if (sub === "publish" && method === "POST") {
      if (s.publishStatus !== 200)
        return json(res, s.publishStatus, { error: "publish_failed" });
      return json(res, 200, { id, versionTag: "v1", sha: "abc123" });
    }
    if (sub === "reset-data" && method === "POST")
      return json(res, 200, { id, seeded: true, migrationsApplied: [] });
    if (sub === "git-versions" && method === "GET") {
      const v = s.versions[id];
      if (!v) return json(res, 404, { error: "no_tags" });
      return json(res, 200, { versions: v });
    }
    if (sub === "rollback" && method === "POST")
      return json(res, 200, { id, sha: "rollback-sha" });
  }

  // ─── templates ─────
  if (p === "/centraid/_templates" && method === "GET")
    return json(res, 200, s.templates);

  // ─── user identity + prefs ─────
  if (p === "/_centraid-user/id" && method === "GET")
    return json(res, 200, { id: "user-test" });
  if (p === "/_centraid-user/prefs") {
    if (method === "GET") return json(res, 200, { prefs: s.prefs });
    if (method === "PUT") {
      const patch = (safeJson(body).patch as Record<string, unknown>) ?? {};
      s.prefs = { ...s.prefs, ...patch };
      return json(res, 200, { prefs: s.prefs });
    }
  }

  // ─── automations ─────
  if (p === "/centraid/_automations") {
    if (method === "GET") {
      if (s.automationsStatus !== 200)
        return json(res, s.automationsStatus, { error: "list_failed" });
      return json(res, 200, { rows: s.automations });
    }
    if (method === "POST")
      return json(
        res,
        200,
        s.createAutomationResult ?? { row: defaultAutomationRow(body) }
      );
    if (method === "DELETE") return json(res, 200, { deletedApp: true });
  }
  if (p === "/centraid/_automations/read" && method === "GET") {
    const ref = url.searchParams.get("ref") ?? "";
    const row = s.automations.find((a) => a.ref === ref) ?? null;
    return json(res, 200, { row });
  }
  if (p === "/centraid/_automations/turn-now" && method === "POST") {
    if (s.runNowStatus !== 200)
      return json(res, s.runNowStatus, { error: "run_failed" });
    // Mirror the gateway: firing a turn materialises its ledger row, so the
    // automation thread feed shows it on the authoritative reload. The thread
    // is the only route to the forensic viewer (Run now does not navigate
    // there itself), so without this the feed stays empty.
    const fired = s.automationTurnsById[s.nextAutomationTurnId];
    if (
      fired &&
      !s.automationTurns.some(
        (turn) => turn["turnId"] === s.nextAutomationTurnId
      )
    ) {
      s.automationTurns = [fired, ...s.automationTurns];
    }
    return json(res, 202, { turnId: s.nextAutomationTurnId });
  }
  if (p === "/centraid/_automations/turns" && method === "GET") {
    const ref = url.searchParams.get("ref");
    const turns = ref
      ? s.automationTurns.filter((turn) => turn.automationId === ref)
      : s.automationTurns;
    return json(res, 200, { turns });
  }
  if (p === "/centraid/_automations/turn" && method === "GET") {
    const turnId = url.searchParams.get("turnId") ?? "";
    const ref = url.searchParams.get("ref");
    const turn =
      s.automationTurnsById[turnId] ??
      (ref
        ? s.automationTurns.find((candidate) => candidate.automationId === ref)
        : undefined) ??
      null;
    return json(res, 200, {
      turn,
      ...(url.searchParams.get("expand") === "items" && turn
        ? {
            items:
              s.automationItemsByTurn[
                typeof turn.turnId === "string" ? turn.turnId : turnId
              ] ?? [],
          }
        : {}),
    });
  }
  if (p === "/centraid/_automations/turn/items" && method === "GET") {
    const turnId = url.searchParams.get("turnId") ?? "";
    return json(res, 200, { items: s.automationItemsByTurn[turnId] ?? [] });
  }
  if (p === "/centraid/_automations/turn/events" && method === "GET") {
    void writeSse(res, s.automationTurnFrames);
    return;
  }
  if (p === "/centraid/_automations/turn/pin" && method === "POST")
    return json(res, 200, { ok: true });
  if (p === "/centraid/_automations/set-enabled" && method === "POST") {
    if (s.setEnabledStatus !== 200)
      return json(res, s.setEnabledStatus, { error: "failed" });
    // Mirror the gateway: the toggle persists, so the thread's reload-after-
    // toggle renders the new state instead of snapping back to the seeded one.
    // `ref` travels in the query string; `enabled` in the body.
    const ref = url.searchParams.get("ref");
    const next = safeJson(body)["enabled"];
    s.automations = s.automations.map((a) =>
      a["ref"] === ref
        ? {
            ...a,
            enabled: next,
            ...(a["manifest"] && typeof a["manifest"] === "object"
              ? {
                  manifest: {
                    ...(a["manifest"] as Record<string, unknown>),
                    enabled: next,
                  },
                }
              : {}),
          }
        : a
    );
    return json(res, 200, { ok: true });
  }

  // ─── insights ─────
  if (p === "/centraid/_insights/summary" && method === "GET")
    return json(res, 200, s.insights);

  // ─── home daily brief (canonical plane: /centraid/_brief/today) ─────
  if (
    (p === "/centraid/_brief/today" || p === "/centraid/_brief/daily") &&
    method === "GET"
  )
    return json(res, 200, s.dailyBrief);

  // ─── harness / agents ─────
  if (p === "/centraid/_turn/harness-status" && method === "GET")
    return json(res, 200, s.harnessStatus);
  if (p === "/centraid/_harnesses/status" && method === "GET")
    return json(res, 200, s.harnessesStatus);

  // ─── vault atlas (v11 Vault embeds the census) ─────
  // The absorb fallback is `{}`. `AtlasScreen` refuses a non-census 200 rather
  // than treating it as a census and crashing on `stats.packs`, and the mock
  // serves a valid empty census so household e2e is deterministic.
  if (p === "/centraid/_vault/atlas/stats" && method === "GET") {
    return json(res, 200, {
      generatedAt: "2026-08-01T00:00:00.000Z",
      method: "estimate",
      fileBytesTotal: 0,
      packs: [],
      totals: { rows: 0, bytes: 0, kinds: 0, populatedKinds: 0 },
    });
  }
  if (p === "/centraid/_vault/atlas/pulse" && method === "GET") {
    return json(res, 200, {
      generatedAt: "2026-08-01T00:00:00.000Z",
      since: "2026-07-02T00:00:00.000Z",
      windowDays: 30,
      live: true,
      series: [],
    });
  }
  if (p === "/centraid/_vault/atlas/graph" && method === "GET") {
    return json(res, 200, {
      generatedAt: "2026-08-01T00:00:00.000Z",
      center: "core_party",
      nodes: [],
      fkEdges: [],
      authoredLinks: [],
      island: [],
      edgeCount: 0,
      centerEdgeCount: 0,
      selfRefCount: 0,
    });
  }

  // ─── enrichment policy + engine profiles (issue #807) ─────
  // Tiers, rules and answers are vault state; profiles are gateway prefs, and
  // the two paths stay separate here exactly as they are in the product.
  if (p === "/centraid/_enrich/profiles" && method === "GET")
    return json(res, 200, { profiles: s.enrichProfiles });
  if (p === "/centraid/_vault/enrich") {
    if (method === "GET")
      return json(res, 200, { enrich: s.enrich, rules: s.enrichRules });
    if (method === "PUT") {
      s.enrich = { ...s.enrich, ...safeJson(body) };
      return json(res, 200, { enrich: s.enrich });
    }
  }
  if (p === "/centraid/_vault/enrich/effective" && method === "GET") {
    // Keyed by capability, matching the real resolver's answer shape. A
    // capability the test did not seed resolves to null, which is exactly what
    // the page renders as "this build has no words for it".
    const capability = url.searchParams.get("capability") ?? "";
    return json(res, 200, {
      tier: s.enrich[url.searchParams.get("domain") ?? ""] ?? null,
      rules: s.enrichRules,
      effective: s.enrichEffective[capability] ?? null,
    });
  }
  if (p === "/centraid/_vault/enrich/rules" && method === "PUT") {
    // One scope's decision about one capability. The owner route answers with
    // the stored rule, which is what the page re-reads rather than assuming.
    const rule = safeJson(body) as Record<string, unknown>;
    return json(res, 200, {
      rule: { ...rule, updatedAt: new Date().toISOString() },
    });
  }
  if (p === "/centraid/_vault/enrich/consent" && method === "GET")
    return json(res, 200, { consent: s.enrichConsent });

  // ─── vault consent context used by the current automation fleet/thread ─────
  // NOT part of the agent→harness rename: `_vault/agents` lists *enrolled
  // automation agents* (the consent-grant identity), not harnesses, and
  // `vault-routes.ts` still answers `{ agents }`. Renaming the key here made
  // `listAgents()` return undefined, so `loadAutomationsOverviewData` threw on
  // `agents.find(...)` for every seeded row — the whole overview died.
  if (p === "/centraid/_vault/agents" && method === "GET")
    return json(res, 200, { agents: [] });
  if (p === "/centraid/_vault/blocking" && method === "GET")
    return json(res, 200, {
      outbox: [],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
  if (p === "/centraid/_vault/outbox-grants" && method === "GET")
    return json(res, 200, { grants: [] });

  // ─── Household / sharing plane (#781) ─────
  // Serves the roster and owner-scope reads the Household journey renders
  // from. Each handler mirrors the real route's response shape (cited inline);
  // the desktop bearer is the host-custody caller, so visibility is "all of
  // it", matching each route's host-custody branch.

  // owners-routes.ts GET: `sendJson(res, 200, {owners: […ownerDto]})`.
  if (p === "/centraid/_gateway/owners" && method === "GET")
    return json(res, 200, { owners: s.owners });

  // devices-routes.ts GET: `{devices}` sorted current-first then label
  // (`compareDevices`), one row per (device, vault) enrollment.
  if (p === "/centraid/_gateway/devices" && method === "GET") {
    const devices = [...s.devices].sort((a, b) => {
      if (a.current === true && b.current !== true) return -1;
      if (b.current === true && a.current !== true) return 1;
      return String(a.label ?? "").localeCompare(String(b.label ?? ""));
    });
    return json(res, 200, { devices });
  }

  // scopes-routes.ts GET: `{scopes: ScopeRow[]}` in registry order.
  // `installed` is present only when the request named `?app=` — with no app
  // named the field is omitted entirely (not asked ≠ not installed).
  if (p === "/centraid/_vault/scopes" && method === "GET") {
    const appId = url.searchParams.get("app");
    const scopes = s.scopes.map((row) => {
      const { installed, ...rest } = row;
      return appId ? { ...rest, installed: installed === true } : rest;
    });
    return json(res, 200, { scopes });
  }

  // vault-links-routes.ts: list and approve.
  if (p === "/centraid/_gateway/links" && method === "GET")
    return json(res, 200, { links: s.links });
  if (seg[0] === "centraid" && seg[1] === "_gateway" && seg[2] === "links") {
    const linkId = decodeURIComponent(seg[3] ?? "");
    if (seg[4] === "approve" && method === "POST") {
      // The real route approves the CALLER's side; the caller here owns the
      // vaults the scopes plane lists, so that side is the one that flips.
      const own = new Set(s.scopes.map((row) => row.vaultId));
      s.links = s.links.map((link) => {
        if (link.linkId !== linkId) return link;
        const approvedByA =
          link.approvedByA === true || own.has(link.vaultA as string);
        const approvedByB =
          link.approvedByB === true || own.has(link.vaultB as string);
        return {
          ...link,
          approvedByA,
          approvedByB,
          approved: approvedByA && approvedByB,
        };
      });
      const approved = s.links.find((link) => link.linkId === linkId) ?? null;
      return json(res, 200, { link: approved });
    }
  }

  // edges-routes.ts GET (`{edges}`). There are no pending/answer verbs —
  // copy-as-share does not exist (#825, ruling G-copy) — and they are
  // deliberately NOT served here: a fixture that answered a route the gateway
  // 404s would let a journey pass against a fiction.
  if (p === "/centraid/_gateway/edges" && method === "GET")
    return json(res, 200, { edges: s.edges });

  // commons-routes.ts invitations (list / claim / answer).
  if (p === "/centraid/_gateway/commons/invitations" && method === "GET") {
    const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
    return json(res, 200, {
      invitations: s.commonsInvitations.filter(
        (row) => row.memberVaultId === actorVaultId
      ),
    });
  }
  if (p === "/centraid/_gateway/commons/invitations/claim" && method === "POST")
    return json(res, 200, { claimed: true });
  if (
    seg[0] === "centraid" &&
    seg[1] === "_gateway" &&
    seg[2] === "commons" &&
    seg[3] === "invitations" &&
    seg[5] === "answer" &&
    method === "POST"
  ) {
    const invitationId = decodeURIComponent(seg[4] ?? "");
    const answer = safeJson(body)["answer"];
    const status = answer === "accept" ? "accepted" : "refused";
    s.commonsInvitations = s.commonsInvitations.map((row) =>
      row.invitationId === invitationId
        ? { ...row, status, answeredAt: new Date().toISOString() }
        : row
    );
    const invitation =
      s.commonsInvitations.find((row) => row.invitationId === invitationId) ??
      null;
    return json(res, 200, { invitation });
  }

  // device-work-routes.ts GET status: `{vaults: [{vaultId, name, total,
  // available, leased}]}` — the roster's "N queued · M leased" note.
  if (p === "/centraid/_gateway/device-work/status" && method === "GET")
    return json(res, 200, { vaults: s.deviceWork });

  // commons-recovery-routes.ts GET: the `CommonsVaultObservability` body —
  // `{vaultId, grants}`; the client keeps only the fields it renders.
  if (p === "/centraid/_gateway/commons/recovery" && method === "GET") {
    const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
    return json(res, 200, {
      vaultId: actorVaultId,
      grants: s.commonsRecovery[actorVaultId] ?? [],
    });
  }

  // ─── unified chat turn (SSE) ─────
  if (seg[0] === "centraid" && seg[2] === "_turn" && method === "POST") {
    void writeSse(res, s.turnFrames);
    return;
  }

  // ─── conversations ─────
  if (
    seg[0] === "_centraid-conversations" &&
    seg[1] === "apps" &&
    seg[3] === "sessions"
  ) {
    const sid = seg[4];
    if (sid) {
      if (method === "GET")
        return json(res, 200, {
          id: sid,
          title: "",
          createdAt: 0,
          messages: s.conversationMessages,
        });
      if (method === "PATCH" || method === "DELETE")
        return json(res, 200, { ok: true });
    } else {
      if (method === "GET")
        return json(res, 200, { sessions: s.conversations });
      if (method === "POST") {
        const title = (safeJson(body).title as string) ?? "";
        const now = Date.now();
        const conv = {
          id: `conv-${s.conversations.length + 1}`,
          title,
          createdAt: now,
          updatedAt: now,
          pinned: false,
          archived: false,
        };
        s.conversations.unshift(conv);
        return json(res, 200, conv);
      }
    }
  }
  if (
    seg[0] === "_centraid-conversations" &&
    seg[3] === "blobs" &&
    method === "POST"
  ) {
    return json(res, 200, { hash: "blob-hash", sizeBytes: body.length });
  }

  // Absorb ambient/unknown calls so the renderer never blows up.
  json(res, 200, {});
}

async function writeMockApp(
  appsDir: string,
  id: string,
  app: Partial<AppMetaEntry>
): Promise<void> {
  const directory = path.join(appsDir, id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "app.json"),
    `${JSON.stringify({ id, name: app.name ?? id, kind: app.kind ?? "app" }, null, 2)}\n`
  );
}

async function readMockApps(appsDir: string): Promise<{
  apps: AppMetaEntry[];
  automations: Array<Record<string, unknown>>;
}> {
  const entries = await fs
    .readdir(appsDir, { withFileTypes: true })
    .catch(() => []);
  const apps: AppMetaEntry[] = [];
  const automations: Array<Record<string, unknown>> = [];
  await forEachSequentially(entries, async (entry) => {
    if (!entry.isDirectory()) return;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(appsDir, entry.name, "app.json"), "utf8")
      ) as Partial<AppMetaEntry>;
      const id = manifest.id ?? entry.name;
      if (manifest.kind === "automation") {
        automations.push(automationRow({ id, name: manifest.name }));
      } else {
        apps.push(appEntry({ ...manifest, id }));
      }
    } catch {
      // A half-written directory is intentionally absent from the mock's
      // restart inventory, matching the gateway's manifest boundary.
    }
  });
  return { apps, automations };
}

function safeJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function defaultCloneResult(body: string): Record<string, unknown> {
  const templateId = (safeJson(body).templateId as string) ?? "template";
  const id = `${templateId}-clone`;
  return {
    app: { id, name: "Cloned app", description: "", kind: "app" },
    template: {
      id: templateId,
      name: "Template",
      desc: "",
      colorKey: "violet",
      iconKey: "Todo",
      version: "1",
      kind: "app",
    },
    webhooks: [],
  };
}

function defaultAutomationRow(body: string): Record<string, unknown> {
  const parsed = safeJson(body);
  const id = (parsed.id as string) ?? "auto-1";
  return {
    id,
    dir: `/${id}`,
    name: (parsed.name as string) ?? "New automation",
    ref: `${id}/${id}`,
    enabled: false,
    triggers: [],
    ownerApp: id,
    manifest: {
      name: (parsed.name as string) ?? "New automation",
      version: "1",
      enabled: false,
      prompt: "",
      triggers: [],
      requires: {},
      history: { keep: "all" },
      generated: { by: "test", at: "2024-01-01T00:00:00Z" },
    },
  };
}

// ─────────────────────────── environment ───────────────────────────

export interface TestEnv {
  workspace: string;
  userData: string;
  gatewayId: string;
  appsDir: string;
  gatewayProxies: Record<string, string>;
}

export async function makeEnv(): Promise<TestEnv> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "centraid-e2e-"));
  const userData = path.join(workspace, "userData");
  await fs.mkdir(userData, { recursive: true });
  const gatewayId = crypto.randomBytes(32).toString("hex");
  // Mock-owned app files are fixture data, not desktop connection state.
  const appsDir = path.join(workspace, "mock-apps");
  await fs.mkdir(appsDir, { recursive: true });
  return { workspace, userData, gatewayId, appsDir, gatewayProxies: {} };
}

export async function cleanupEnv(env: TestEnv): Promise<void> {
  await fs.rm(env.workspace, { recursive: true, force: true });
}

/**
 * Seed a REMOTE gateway profile pointing at the mock, mark it active, and
 * (by default) mark onboarding complete so the app boots straight to home.
 * Pass `{ onboarding: true }` to leave onboarding pending (the first-run view).
 */
export async function seedRemoteGateway(
  env: TestEnv,
  gateway: { url: string },
  opts: { onboarding?: boolean } = {}
): Promise<void> {
  await seedRemoteGatewayProfile(env, gateway, {
    id: env.gatewayId,
    label: "E2E Gateway",
  });
  await fs.writeFile(
    path.join(env.userData, "centraid-settings.json"),
    JSON.stringify(
      {
        activeGatewayId: env.gatewayId,
        changelogSeenVersion: "0.1.0",
        ...(opts.onboarding
          ? {}
          : { onboardingCompletedAt: "2024-01-01T00:00:00.000Z" }),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

/** Seed an additional paired remote profile without changing the active gateway. */
export async function seedRemoteGatewayProfile(
  env: TestEnv,
  gateway: { url: string },
  opts: { id?: string; label?: string } = {}
): Promise<string> {
  const id = opts.id ?? crypto.randomBytes(32).toString("hex");
  const label = opts.label ?? "E2E Gateway";
  const file = path.join(env.userData, "connections.json");
  const profiles = JSON.parse(
    await fs.readFile(file, "utf8").catch(() => "[]")
  ) as Array<Record<string, unknown>>;
  profiles.push({
    id,
    kind: "remote",
    label,
    displayName: label,
    endpointId: id,
    rememberDevice: false,
    createdAt: "2024-01-01T00:00:00.000Z",
  });
  await fs.writeFile(file, `${JSON.stringify(profiles, null, 2)}\n`, {
    mode: 0o600,
  });
  env.gatewayProxies[id] = gateway.url;
  return id;
}

export async function launchApp(
  env: TestEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  const desktopRoot = path.resolve(__dirname, "..", "..");
  const main = path.join(desktopRoot, "dist", "main.js");
  await fs.access(main).catch(() => {
    throw new Error(
      `dist/main.js not found at ${main}. Run \`npm run build\` in apps/desktop first.`
    );
  });
  // Launch through a test-only entry that applies e2e-specific main-process
  // setup (the Linux keyring backend switch) and then loads the real app, so
  // production main.ts stays free of any test/CI/platform branches. Electron
  // resolves the app root by walking up to apps/desktop/package.json, so the
  // app behaves identically to launching `desktopRoot` directly.
  const entry = path.join(__dirname, "electron-entry.mjs");
  const app = await _electron.launch({
    args: [entry, `--user-data-dir=${env.userData}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      // The local gateway moved out of Electron userData in #555. Keep every
      // E2E worker's real gateway state inside its disposable workspace so it
      // cannot contend with the developer's/service's canonical gateway.db.
      CENTRAID_DATA_DIR: path.join(env.workspace, "gateway-data"),
      CENTRAID_EMBEDDED_GATEWAY: "1",
      CENTRAID_E2E_IROH_PROXY_MAP: JSON.stringify(env.gatewayProxies),
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => {
    process.stderr.write(
      `[desktop-e2e pageerror] ${error.stack ?? error.message}\n`
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      process.stderr.write(`[desktop-e2e console] ${message.text()}\n`);
    }
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

// ─────────────────────────── DOM helpers ───────────────────────────

/** A published-app metadata row for the gateway's listApps response. */
export function appEntry(
  over: Partial<AppMetaEntry> & { id: string }
): AppMetaEntry {
  return {
    ...over,
    name: over.name ?? over.id,
    kind: over.kind ?? "app",
  };
}

/** Build a CentraidAutomationRow for the listAutomations / read responses. */
export function automationRow(over: {
  id: string;
  name?: string;
  enabled?: boolean;
  triggers?: Array<Record<string, unknown>>;
  description?: string;
}): Record<string, unknown> {
  const id = over.id;
  const ref = `${id}/${id}`;
  const triggers = over.triggers ?? [{ kind: "cron", expr: "0 9 * * *" }];
  return {
    id,
    dir: `/${id}`,
    name: over.name ?? id,
    ref,
    enabled: over.enabled ?? true,
    triggers,
    ownerApp: id,
    manifest: {
      name: over.name ?? id,
      version: "1",
      description: over.description ?? "",
      enabled: over.enabled ?? true,
      prompt: "Do the thing.",
      triggers,
      requires: { model: "tier-deep" },
      history: { keep: "all" },
      generated: { by: "test", at: "2024-01-01T00:00:00Z" },
    },
  };
}

/** Build a native CentraidAutomationTurnRecord. */
export function automationTurnRecord(over: {
  turnId: string;
  automationId: string;
  ok?: boolean;
  summary?: string;
  error?: string;
  triggerKind?: string;
  triggerOrigin?: string;
}): Record<string, unknown> {
  return {
    turnId: over.turnId,
    conversationId: over.automationId,
    seq: 0,
    automationId: over.automationId,
    triggerKind: over.triggerKind ?? "manual",
    triggerOrigin: over.triggerOrigin ?? "manual",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_002_500,
    ok: over.ok ?? true,
    ...(over.summary ? { summary: over.summary } : {}),
    ...(over.error ? { error: over.error } : {}),
    pinned: false,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.001,
    stepCount: 1,
    toolCount: 1,
  };
}

/** Build a native CentraidAutomationItem. */
export function automationTurnItem(over: {
  turnId: string;
  ordinal: number;
  kind?: string;
  name?: string;
  ok?: boolean;
  argsJson?: string;
  outputJson?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    itemId: `${over.turnId}-i${over.ordinal}`,
    turnId: over.turnId,
    ordinal: over.ordinal,
    kind: over.kind ?? "tool",
    name: over.name ?? "do_thing",
    argsJson: over.argsJson ?? '{"x":1}',
    outputJson: over.outputJson ?? '{"ok":true}',
    ok: over.ok ?? true,
    ...(over.error ? { error: over.error } : {}),
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    model: "tier-deep",
    harness: "test",
  };
}

/** Build one `ownerDto` row (owners-routes.ts) for `state.owners`. */
export function gatewayOwnerRecord(over: {
  ownerId: string;
  label: string;
  vaults?: Array<{ vaultId: string; vaultName?: string }>;
  deviceCount?: number;
}): Record<string, unknown> {
  return {
    ownerId: over.ownerId,
    label: over.label,
    createdAt: "2026-01-01T00:00:00.000Z",
    vaults: over.vaults ?? [],
    deviceCount: over.deviceCount ?? 0,
  };
}

/** Build one `DeviceDTO` enrollment row (devices-routes.ts) for `state.devices`. */
export function gatewayDeviceRecord(over: {
  deviceId: string;
  endpointId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  vaultId: string;
  vaultName?: string;
  current?: boolean;
  platform?: string;
  revoked?: boolean;
}): Record<string, unknown> {
  return {
    deviceId: over.deviceId,
    endpointId: over.endpointId,
    ownerId: over.ownerId,
    ownerLabel: over.ownerLabel,
    label: over.label,
    ...(over.platform === undefined ? {} : { platform: over.platform }),
    transport: "iroh",
    vaultId: over.vaultId,
    ...(over.vaultName === undefined ? {} : { vaultName: over.vaultName }),
    addedAt: "2026-02-01T00:00:00.000Z",
    lastUsedAt: "2026-02-02T00:00:00.000Z",
    current: over.current === true,
    revoked: over.revoked === true,
    rememberDevice: false,
  };
}

/** Build one `ScopeRow` (scopes-routes.ts) for `state.scopes`. */
export function scopeRowRecord(over: {
  vaultId: string;
  label: string;
  personal?: boolean;
  installed?: boolean;
}): Record<string, unknown> {
  return {
    vaultId: over.vaultId,
    label: over.label,
    personal: over.personal === true,
    // Every row the route lists is owned by the caller, so it is writable —
    // a per-row wire field sourced by the gateway, never derived client-side.
    canWrite: true,
    ...(over.installed === undefined ? {} : { installed: over.installed }),
  };
}

/** Build one `linkDto` row (vault-links-routes.ts) for `state.links`. */
export function gatewayLinkRecord(over: {
  linkId: string;
  vaultA: string;
  vaultB: string;
  labelA?: string | null;
  labelB?: string | null;
  approvedByA?: boolean;
  approvedByB?: boolean;
  remoteVaultId?: string | null;
  revoked?: boolean;
}): Record<string, unknown> {
  const approvedByA = over.approvedByA === true;
  const approvedByB = over.approvedByB === true;
  return {
    linkId: over.linkId,
    vaultA: over.vaultA,
    vaultB: over.vaultB,
    labelA: over.labelA ?? null,
    labelB: over.labelB ?? null,
    partyIdA: null,
    partyIdB: null,
    approvedByA,
    approvedByB,
    approved: approvedByA && approvedByB,
    remoteVaultId: over.remoteVaultId ?? null,
    revoked: over.revoked === true,
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

/** Build one commons observability grant (commons-observability.ts), with only
 *  the fields the client's recovery surface renders plus honest zero counters. */
export function commonsRecoveryGrantRecord(over: {
  grantId: string;
  containerType: string;
  presence: "unknown" | "reachable" | "degraded" | "absent" | "parked";
  stewardVaultId?: string;
  silentForMs?: number;
  supersededBy?: string;
}): Record<string, unknown> {
  return {
    grantId: over.grantId,
    containerType: over.containerType,
    steward: {
      presence: over.presence,
      ...(over.stewardVaultId === undefined
        ? {}
        : { stewardVaultId: over.stewardVaultId }),
      ...(over.silentForMs === undefined
        ? {}
        : { silentForMs: over.silentForMs }),
    },
    reachableRatio: null,
    absence: { episodes: 0, totalMs: 0, longestMs: 0, openMs: null },
    pullOutcomes: { noop: 0, tail: 0, snapshot: 0 },
    ...(over.supersededBy === undefined
      ? {}
      : { supersededBy: over.supersededBy }),
  };
}

/** Mark an app "known/published" in localStorage so it isn't classed a draft. */
export async function markUserApp(
  page: Page,
  app: { id: string; name: string; desc?: string }
): Promise<void> {
  await page.evaluate((a) => {
    const KEY = "centraid.v1.home.userApps";
    const existing = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Array<
      Record<string, unknown>
    >;
    existing.push({
      id: a.id,
      name: a.name,
      desc: a.desc ?? "Built with Centraid.",
      iconKey: "Todo",
      color: "#5847e0",
      colorKey: "violet",
      centraidAppId: a.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    localStorage.setItem(KEY, JSON.stringify(existing));
  }, app);
}

/** Wait for the home shell to be present.
 *
 *  The stem is the chrome root and Home is the content springboard (or day-one
 *  first-moves), not a library shelf (#707/#708). Wait past the "Reading your
 *  vault…" WorkingState so tests see the
 *  graded treatment (springboard or first-run), not the loading skeleton.
 */
export async function waitForHome(page: Page): Promise<void> {
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  const home = page.locator(
    '[data-testid="home-springboard"], [data-testid="home-first-run"]'
  );
  try {
    await home.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    const body = (await page.locator("body").textContent())
      ?.replaceAll(/\s+/gu, " ")
      .slice(0, 500);
    throw new Error(
      `home springboard did not render at ${page.url()}; shell text: ${body ?? ""}`,
      {
        cause: error,
      }
    );
  }
}

/** Open the ⌘K / Ctrl+K command palette (stem Search, with keyboard fallback). */
export async function openCommandPalette(page: Page): Promise<void> {
  // Stem Search's accessible name is "Search" or "Search ⌘K" depending on host.
  // Always .first() — other surfaces can also expose a Search control.
  const search = page.getByRole("button", { name: /^Search/u });
  if ((await search.count()) > 0) {
    await search.first().click();
  } else {
    await page.keyboard.press("ControlOrMeta+k");
  }
  await page
    .getByRole("dialog", { name: "Command palette" })
    .waitFor({ state: "visible" });
}

/**
 * The shell has one status line and no toasts (#707). Notes from `showToast` /
 * `postStatus` land here as polite live-region text.
 */
export function statusLine(page: Page) {
  return page.locator("output[aria-live='polite']").first();
}

/** Open an installed (or draft) app by its display name via the command palette.
 *
 *  Home lists no custom apps as library cards (#708) — the palette is the
 *  durable open path for anything that is not a first-party springboard
 *  tile. First-party apps also appear here under the Apps group.
 */
export async function openAppFromPalette(
  page: Page,
  appName: string
): Promise<void> {
  await openCommandPalette(page);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(appName);
  await palette
    .getByRole("button")
    .filter({ hasText: appName })
    .first()
    .click();
}

/** How long a test waits for a well-behaved Electron shutdown before forcing it. */
const CLOSE_TIMEOUT_MS = 8_000;

/** Close Electron and wait until its OS process has exited.
 *
 * `ElectronApplication.close()` can resolve just before Chromium releases the
 * app's single-instance lock. Tests that immediately relaunch must wait for the
 * process boundary, otherwise the replacement process exits without a window.
 *
 * The close is BOUNDED. Left unbounded, a hung teardown surfaces as "Test
 * timeout of 60000ms exceeded" pointing at the test body even though every
 * assertion passed, with a trace showing a `close()` and no matching `after`.
 * That is maximally misleading: a shutdown bug reported as a product bug. So we
 * cap the wait, SIGKILL the Electron process if it overruns, and shout about it
 * on stderr. The test still passes (its assertions did pass), but the force-kill
 * is loud enough to be findable in CI logs instead of silently absorbed.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  // Idempotent: the restart tests close mid-body and close again from their
  // outer `finally` as a backstop. Playwright throws from `process()` once the
  // application is gone, which for a teardown helper just means "already
  // closed" — nothing left to do.
  let child: ReturnType<ElectronApplication["process"]>;
  try {
    child = app.process();
  } catch {
    return;
  }
  const exited =
    child.exitCode === null
      ? new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        })
      : Promise.resolve();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS);
  });

  // Swallowed here, not at the race: if we end up force-killing, the pending
  // `close()` rejects later with nobody awaiting it, and an unhandled rejection
  // would fail an unrelated test further down the file.
  const closed = app.close().catch(() => undefined);

  try {
    const outcome = await Promise.race([
      Promise.all([closed, exited]).then(() => "closed" as const),
      deadline,
    ]);
    if (outcome === "timeout") {
      const where = testTitle();
      process.stderr.write(
        `\n[desktop-e2e] !! FORCE-KILL: electronApplication.close() did not return within ` +
          `${CLOSE_TIMEOUT_MS}ms during "${where}". The test body is NOT at fault — this is a ` +
          `main-process teardown hang. SIGKILLing pid ${child.pid ?? "?"} so the worker is not ` +
          `wedged.\n\n`
      );
      child.kill("SIGKILL");
      await exited;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best-effort name of the running test, for the force-kill warning. */
function testTitle(): string {
  try {
    return test.info().titlePath.slice(1).join(" › ") || "unknown test";
  } catch {
    return "unknown test (outside a test)";
  }
}

/**
 * Rail renames from #667 — older e2e labels still resolve to the current
 * button text so call sites that predate the IA pass do not go dark.
 */
const RAIL_LABEL_ALIASES: Readonly<Record<string, string>> = {
  Analytics: "Activity",
  Data: "Vault",
  Devices: "Vault",
  Gateway: "System",
  Household: "Vault",
  Insights: "Activity",
  "Vault Atlas": "Vault",
};

/** Click a stem nav item by its visible label.
 *
 *  The default launcher is deliberately short, so an E2E journey may ask for
 *  an unpinned destination. Prefer the standing row when it exists; otherwise
 *  use the frame's honest All apps/More door instead of teaching fixtures a
 *  private route shortcut. Scope lookups because app routes may also render a
 *  same-named app-bar verb (for example, Automations after a template clone). */
export async function gotoNav(page: Page, label: string): Promise<void> {
  const railLabel = RAIL_LABEL_ALIASES[label] ?? label;
  const stem = page.locator('nav[aria-label="Apps"]');
  const pinned = stem.getByRole("button", { name: railLabel, exact: true });
  if ((await pinned.count()) > 0) {
    await pinned.click();
    return;
  }

  const allApps = stem.getByRole("button", {
    name: /^(?:All apps|More)$/u,
  });
  await allApps.click();
  await page
    .getByRole("dialog", { name: "All apps" })
    .getByRole("button", { name: railLabel, exact: true })
    .click();
}

/** The grid item for an app, keyed by its stable data-app-id anchor.
 *
 *  Matches springboard content tiles, day-one first-moves, and library AppCards
 *  (Starred / overview). Prefer `.first()` at the call site when both a move
 *  and a tile could match during transitions.
 */
export function tile(page: Page, appId: string) {
  return page.locator(`[data-app-id="${appId}"]`);
}

/** Open an app from Home (springboard tile or first-move) by id. */
export async function openTile(page: Page, appId: string): Promise<void> {
  // The springboard button IS the tile (data-testid="home-tile"); first-moves
  // and AppCards also carry data-app-id. Click the anchor itself — Home
  // renders no nested app-tile child to require.
  await tile(page, appId).first().click();
}

/** Open a tile's overflow (⋯) action menu. Locate it by accessible role/name,
 * never by class — card restyles churn the classes (#230). AppCards (Starred)
 * expose this;
 * springboard tiles do not — use openAppFromPalette + Build for that path. */
export async function openTileMenu(page: Page, appId: string): Promise<void> {
  await tile(page, appId).getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu").waitFor({ state: "visible" });
}

/** Click a context-menu item by text. */
export async function clickMenuItem(page: Page, text: string): Promise<void> {
  await page.getByRole("menuitem", { name: text, exact: true }).click();
}

/** Wait for the confirm modal with the given title. */
export async function expectConfirm(page: Page, title: string): Promise<void> {
  await page
    .getByRole("dialog", { name: title, exact: true })
    .waitFor({ state: "visible" });
}

/** Click the danger "Delete" button in the open confirm modal. */
export async function confirmDelete(page: Page): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}
