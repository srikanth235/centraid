import http from "node:http";
import type * as TypeImport_1cs0ag8 from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
// governance: allow-repo-hygiene file-size-limit #526 Keep broker custody and Assist regression scenarios together.
// The connection broker (issue #304): token custody correctness. The three
// rot points each get a scenario — rotated pair persisted before use,
// single-flight refresh under concurrency, invalid_grant flips needs-auth
// with an owner-readable note while a 5xx stays transient (no flip).
import { tempDir } from "@centraid/test-kit/temp-dir";
import { sealAad, unsealValue } from "@centraid/vault";

import { ASSIST_DEVELOPMENT_WORKER_ORIGIN } from "./assist-oauth.js";
import { ConnectionBroker } from "./connection-broker.js";
import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("connection-broker", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function openPlane(dir: string): VaultPlane {
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  interface TokenServer {
    url: string;
    requests: Array<Record<string, string>>;
    respond: (
      body:
        | Record<string, unknown>
        | { status: number; body: Record<string, unknown> }
    ) => void;
  }

  /** A token endpoint that accepts the connection but never answers — simulates a wedged IdP. */
  async function startHangingTokenServer(): Promise<{ url: string }> {
    const sockets = new Set<TypeImport_1cs0ag8.Socket>();
    const server = http.createServer(() => {
      /* never respond */
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/token` };
  }

  /** A scriptable token endpoint: push one response per expected request. */
  async function startTokenServer(): Promise<TokenServer> {
    const responses: Array<{ status: number; body: Record<string, unknown> }> =
      [];
    const requests: Array<Record<string, string>> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString();
      });
      req.on("end", () => {
        requests.push(Object.fromEntries(new URLSearchParams(raw)));
        const next = responses.shift() ?? {
          status: 500,
          body: { error: "unscripted" },
        };
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/token`,
      requests,
      respond: (r) =>
        responses.push(
          "status" in r && typeof r.status === "number"
            ? (r as { status: number; body: Record<string, unknown> })
            : { status: 200, body: r as Record<string, unknown> }
        ),
    };
  }

  function configureOauth(
    plane: VaultPlane,
    tokenUrl: string,
    over: Record<string, unknown> = {}
  ): string {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.gmail",
        label: "personal",
        cred_kind: "oauth2",
        provider: "google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: tokenUrl,
        client_id: "cid.apps.googleusercontent.com",
        client_secret: "GOCSPX-broker-test",
        allowed_hosts: ["gmail.googleapis.com"],
        ...over,
      },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed")
      throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
    return (outcome as { output: { connection_id: string } }).output
      .connection_id;
  }

  function configureAssist(plane: VaultPlane): string {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.gcal",
        label: "Centraid Assist",
        cred_kind: "oauth2",
        oauth_mode: "assist",
        provider: "google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/calendar.events",
        client_id: "shared.apps.googleusercontent.com",
        allowed_hosts: ["www.googleapis.com", "oauth2.googleapis.com"],
      },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed") {
      throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
    }
    return (outcome as { output: { connection_id: string } }).output
      .connection_id;
  }

  function storeTokens(
    plane: VaultPlane,
    connectionId: string,
    input: Record<string, unknown>
  ): void {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.store_tokens",
      input: { connection_id: connectionId, ...input },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed")
      throw new Error(`store failed: ${JSON.stringify(outcome)}`);
  }

  function connectionRow(
    plane: VaultPlane,
    connectionId: string
  ): Record<string, unknown> {
    return plane.db.vault
      .prepare(
        `SELECT c.status, h.auth_note, cc.access_token, cc.refresh_token
         FROM sync_connection c
         LEFT JOIN sync_connection_credential cc ON cc.connection_id = c.connection_id
         LEFT JOIN sync_connection_health h ON h.connection_id = c.connection_id
        WHERE c.connection_id = ?`
      )
      .get(connectionId) as Record<string, unknown>;
  }

  test("api_key connections resolve to injectable values without any network", async () => {
    const plane = openPlane(await tempDir());
    plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.github",
        label: "personal",
        cred_kind: "api_key",
        api_key: "ghp_broker_live",
        allowed_hosts: ["api.github.com"],
      },
      purpose: "dpv:ServiceProvision",
    });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.github",
      label: "personal",
    });
    expect(auth && "values" in auth ? auth.values : undefined).toStrictEqual({
      api_key: "ghp_broker_live",
    });
    expect(
      auth && "allowedHosts" in auth ? auth.allowedHosts : []
    ).toStrictEqual(["api.github.com"]);
  });

  test("provider polling keeps credentials broker-side and enforces the durable account host pin", async () => {
    const plane = openPlane(await tempDir());
    const configured = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.github",
        label: "work",
        cred_kind: "api_key",
        provider: "github",
        api_key: "github-secret-token",
        allowed_hosts: ["api.github.com"],
      },
      purpose: "dpv:ServiceProvision",
    });
    const connectionId = (configured as { output: { connection_id: string } })
      .output.connection_id;
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer github-secret-token"
        );
        expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
        return Response.json([{ id: "event-1" }], {
          headers: {
            etag: '"v2"',
            link: '<https://api.github.com/repos/acme/app/events?page=2>; rel="next"',
            "x-poll-interval": "60",
          },
        });
      }
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      undefined,
      fetchImpl as typeof fetch
    );
    const binding = { connectionId, kind: "pull.github", label: "work" };

    const result = await broker.pollJson(
      binding,
      "https://api.github.com/repos/acme/app/events",
      {
        "if-none-match": '"v1"',
        authorization: "attacker-supplied",
      }
    );
    expect(result).toStrictEqual({
      status: 200,
      headers: {
        etag: '"v2"',
        link: '<https://api.github.com/repos/acme/app/events?page=2>; rel="next"',
        "x-poll-interval": "60",
      },
      body: [{ id: "event-1" }],
    });
    expect(JSON.stringify(result)).not.toContain("github-secret-token");
    await expect(
      broker.pollJson(binding, "https://evil.example/repos/acme/app/events")
    ).rejects.toThrow(/outside.*allowed_hosts/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("a connection without a broker credential resolves to undefined (harness-ambient lane)", async () => {
    const plane = openPlane(await tempDir());
    const broker = new ConnectionBroker(() => plane);
    await expect(
      broker.resolveForFire({ kind: "pull.gmail", label: "nope" })
    ).resolves.toBeUndefined();
  });

  test("a durable connection id cannot cross connector kinds", async () => {
    const plane = openPlane(await tempDir());
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.github",
        label: "personal",
        cred_kind: "api_key",
        provider: "github",
        api_key: "ghp_broker_live",
        allowed_hosts: ["api.github.com"],
      },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed") throw new Error("configure failed");
    const connectionId = (outcome as { output: { connection_id: string } })
      .output.connection_id;
    const broker = new ConnectionBroker(() => plane);

    await expect(
      broker.resolveForFire({
        kind: "pull.linear",
        label: "work",
        connectionId,
      })
    ).resolves.toBeUndefined();
  });

  test("broker grants read-only POST policy only to its exact provider and kind", async () => {
    const plane = openPlane(await tempDir());
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.linear",
        label: "work",
        cred_kind: "api_key",
        provider: "linear",
        api_key: "lin_api_test",
        allowed_hosts: ["api.linear.app"],
      },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed") throw new Error("configure failed");
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.linear",
      label: "work",
    });
    expect(
      auth && "readOnlyPosts" in auth ? auth.readOnlyPosts : undefined
    ).toStrictEqual([
      { host: "api.linear.app", path: "/graphql", body: "graphql-query" },
    ]);
  });

  test("an unexpired stored token serves without touching the token endpoint", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.long-lived",
      refresh_token: "1//r1",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(auth && "values" in auth ? auth.values : undefined).toStrictEqual({
      access_token: "ya29.long-lived",
    });
    expect(tokens.requests).toHaveLength(0);
  });

  test("a trusted provider id cannot redirect OAuth to substituted endpoints", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureOauth(
      plane,
      "https://oauth2.googleapis.com/token",
      {
        auth_url: "https://attacker.example/authorize",
      }
    );
    const broker = new ConnectionBroker(() => plane);
    expect(() =>
      broker.beginAuthorization(
        plane,
        connectionId,
        "http://127.0.0.1:3210/centraid/_vault/oauth/callback"
      )
    ).toThrow(/does not match its trusted OAuth endpoints/u);
  });

  test("an expired token refreshes; a ROTATED refresh token persists before the new access token is used", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//original",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    tokens.respond({
      access_token: "ya29.fresh",
      refresh_token: "1//rotated",
      expires_in: 3600,
      token_type: "Bearer",
    });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(auth && "values" in auth ? auth.values : undefined).toStrictEqual({
      access_token: "ya29.fresh",
    });
    // The refresh grant carried the original token + the client pair.
    expect(tokens.requests).toHaveLength(1);
    expect(tokens.requests[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "1//original",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "GOCSPX-broker-test",
    });
    // The rotated pair is on the row, sealed, with a fresh expiry.
    const row = connectionRow(plane, connectionId);
    expect(String(row.access_token)).toMatch(/^sealed:v1:/u);
    expect(String(row.refresh_token)).toMatch(/^sealed:v1:/u);
    expect(row.status).toBe("active");
    // A follow-up resolve uses the persisted rotated pair without refreshing.
    const again = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(again && "values" in again ? again.values : undefined).toStrictEqual(
      {
        access_token: "ya29.fresh",
      }
    );
    expect(tokens.requests).toHaveLength(1);
  });

  test("concurrent fires produce ONE refresh (single-flight, no rotation race)", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//original",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    tokens.respond({
      access_token: "ya29.single",
      refresh_token: "1//rotated",
      expires_in: 3600,
    });
    const broker = new ConnectionBroker(() => plane);
    const [a, b, c] = await Promise.all([
      broker.resolveForFire({ kind: "pull.gmail", label: "personal" }),
      broker.resolveForFire({ kind: "pull.gmail", label: "personal" }),
      broker.resolveForFire({ kind: "pull.gmail", label: "personal" }),
    ]);
    expect(tokens.requests).toHaveLength(1);
    for (const auth of [a, b, c]) {
      expect(auth && "values" in auth ? auth.values : undefined).toStrictEqual({
        access_token: "ya29.single",
      });
    }
  });

  test("invalid_grant flips needs-auth with an owner-readable note; the fire is refused", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//revoked",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    tokens.respond({ status: 400, body: { error: "invalid_grant" } });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(auth && "refused" in auth ? auth.refused : undefined).toMatch(
      /invalid_grant/u
    );
    const row = connectionRow(plane, connectionId);
    expect(row.status).toBe("needs-auth");
    expect(String(row.auth_note)).toMatch(/reconnect/u);
  });

  test("a 5xx token endpoint is transient: the fire skips but the connection does NOT flip", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//fine",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    tokens.respond({ status: 500, body: { error: "hiccup" } });
    tokens.respond({ status: 500, body: { error: "hiccup" } });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(auth && "refused" in auth ? auth.refused : undefined).toMatch(
      /transient/u
    );
    // Retried once, then gave up for this fire — status untouched.
    expect(tokens.requests).toHaveLength(2);
    expect(connectionRow(plane, connectionId).status).toBe("active");
  });

  test("a hung token endpoint times out; treated as transient (retried, no flip) — issue #351", async () => {
    const plane = openPlane(await tempDir());
    const hung = await startHangingTokenServer();
    const connectionId = configureOauth(plane, hung.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//fine",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    // A short token timeout so the test doesn't wait out the real 30s default.
    const broker = new ConnectionBroker(() => plane, 30);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    expect(auth && "refused" in auth ? auth.refused : undefined).toMatch(
      /transient/u
    );
    // Same outcome as the 5xx-transient case: no flip, connection stays active.
    expect(connectionRow(plane, connectionId).status).toBe("active");
  });

  test("force refresh (the 401 lane) refreshes even an unexpired token", async () => {
    const plane = openPlane(await tempDir());
    const tokens = await startTokenServer();
    const connectionId = configureOauth(plane, tokens.url);
    storeTokens(plane, connectionId, {
      access_token: "ya29.rejected-upstream",
      refresh_token: "1//r",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    tokens.respond({ access_token: "ya29.after-force", expires_in: 3600 });
    const broker = new ConnectionBroker(() => plane);
    const auth = await broker.resolveForFire({
      kind: "pull.gmail",
      label: "personal",
    });
    if (!auth || !("refresh" in auth) || !auth.refresh)
      throw new Error("expected a refresh hook");
    await expect(auth.refresh()).resolves.toStrictEqual({
      access_token: "ya29.after-force",
    });
    expect(tokens.requests).toHaveLength(1);
  });

  test("Assist state is PKCE-bound, client-session/device-bound, single-use, and exchanged only by the Worker", async () => {
    const plane = openPlane(await tempDir());
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          access_token: "ya29.assist",
          refresh_token: "1//assist",
          expires_in: 3600,
        });
      }
    );
    const connectionId = configureAssist(plane);
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    const ceremony = broker.beginAssistAuthorization({
      plane,
      connectionId,
      clientSessionId: "s".repeat(64),
      deviceKey: "device-a",
      surface: "web",
    });
    const start = new URL(ceremony.authUrl);
    expect(start.origin + start.pathname).toBe(
      `${ASSIST_DEVELOPMENT_WORKER_ORIGIN}/start`
    );
    const startFragment = new URLSearchParams(start.hash.slice(1));
    expect(startFragment.get("browser_binding")).toMatch(
      /^[A-Za-z0-9_-]{43}$/u
    );
    const authorize = new URL(startFragment.get("authorization_url")!);
    expect(authorize.searchParams.get("state")).toMatch(
      /^w\.[A-Za-z0-9_-]{43}$/u
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ASSIST_DEVELOPMENT_WORKER_ORIGIN}/callback`
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.events"
    );
    expect(ceremony.authUrl).not.toMatch(
      /openid|userinfo\.email|userinfo\.profile/u
    );

    // A copied browser fragment cannot burn or redeem another device/session's
    // state. The correctly-bound client can still complete afterwards.
    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.receipt",
        clientSessionId: "x".repeat(64),
        deviceKey: "device-b",
      })
    ).rejects.toThrow(/different client session/u);
    expect(requests).toHaveLength(0);
    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.receipt",
        clientSessionId: "s".repeat(64),
        deviceKey: "device-a",
      })
    ).resolves.toStrictEqual({ connectionId });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/exchange",
      body: {
        provider: "google",
        code: "google-code",
        receipt: "v1.receipt",
        redirect_uri: `${ASSIST_DEVELOPMENT_WORKER_ORIGIN}/callback`,
        state: ceremony.state,
        browser_binding: startFragment.get("browser_binding"),
        scopes: ["https://www.googleapis.com/auth/calendar.events"],
      },
    });
    expect(String(requests[0]!.body.code_verifier)).toMatch(
      /^[A-Za-z0-9_-]{64}$/u
    );
    expect(JSON.stringify(requests[0])).not.toContain("client_secret");
    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.receipt",
        clientSessionId: "s".repeat(64),
        deviceKey: "device-a",
      })
    ).rejects.toThrow(/unknown or expired/u);
  });

  test("Assist ceremony expires without calling the Worker", async () => {
    const plane = openPlane(await tempDir());
    const fetchImpl = vi.fn<typeof fetch>();
    let now = Date.parse("2026-07-23T10:00:00Z");
    const connectionId = configureAssist(plane);
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch,
      () => now
    );
    const ceremony = broker.beginAssistAuthorization({
      plane,
      connectionId,
      clientSessionId: "s".repeat(64),
      surface: "desktop",
    });
    now += 11 * 60 * 1000;
    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.receipt",
        clientSessionId: "s".repeat(64),
      })
    ).rejects.toThrow(/unknown or expired/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("transient Assist exchange failure retries without flipping an active connection", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureAssist(plane);
    storeTokens(plane, connectionId, {
      access_token: "ya29.existing",
      refresh_token: "1//existing",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 })
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    const ceremony = broker.beginAssistAuthorization({
      plane,
      connectionId,
      clientSessionId: "s".repeat(64),
      surface: "desktop",
    });

    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.receipt",
        clientSessionId: "s".repeat(64),
      })
    ).rejects.toThrow(/assist_worker_503/u);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(connectionRow(plane, connectionId).status).toBe("active");
  });

  test("an expired Assist reconnect receipt preserves an existing working token pair", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureAssist(plane);
    storeTokens(plane, connectionId, {
      access_token: "ya29.existing",
      refresh_token: "1//existing",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "expired_receipt" }, { status: 400 })
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    const ceremony = broker.beginAssistAuthorization({
      plane,
      connectionId,
      clientSessionId: "s".repeat(64),
      surface: "desktop",
    });

    await expect(
      broker.completeAssistAuthorization({
        state: ceremony.state,
        code: "google-code",
        receipt: "v1.expired",
        clientSessionId: "s".repeat(64),
      })
    ).rejects.toThrow(/expired_receipt/u);

    expect(connectionRow(plane, connectionId).status).toBe("active");
  });

  test("BYO token posts refuse redirects before credentials can be forwarded", async () => {
    const plane = openPlane(await tempDir());
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        return Response.json({ access_token: "fresh", expires_in: 3600 });
      }
    );
    const connectionId = configureOauth(plane, "https://oauth.example/token", {
      provider: "test-oauth",
      auth_url: "https://oauth.example/authorize",
    });
    const broker = new ConnectionBroker(
      () => plane,
      500,
      undefined,
      fetchImpl as typeof fetch
    );
    const ceremony = broker.beginAuthorization(
      plane,
      connectionId,
      "http://127.0.0.1/oauth/callback"
    );
    const authorize = new URL(ceremony.authUrl);

    await expect(
      broker.completeAuthorization(
        authorize.searchParams.get("state")!,
        "authorization-code"
      )
    ).resolves.toStrictEqual({ connectionId });
  });

  test("Gmail authorization captures the connect-time profile historyId baseline", async () => {
    const plane = openPlane(await tempDir());
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        const url = String(input);
        if (url.includes("/gmail/v1/users/me/profile")) {
          if (
            new Headers(init?.headers).get("authorization") !==
            "Bearer fresh-gmail-token"
          ) {
            throw new Error("profile request must use the fresh Gmail token");
          }
          return Response.json({
            emailAddress: "owner@example.com",
            historyId: "42017",
          });
        }
        return Response.json({
          access_token: "fresh-gmail-token",
          refresh_token: "refresh-gmail-token",
          expires_in: 3600,
        });
      }
    );
    const connectionId = configureOauth(
      plane,
      "https://oauth2.googleapis.com/token"
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      undefined,
      fetchImpl as typeof fetch
    );
    const ceremony = broker.beginAuthorization(
      plane,
      connectionId,
      "http://127.0.0.1/oauth/callback"
    );
    await broker.completeAuthorization(ceremony.state, "authorization-code");

    const cursor = plane.db.vault
      .prepare(
        `SELECT value_json FROM sync_connection_cursor
        WHERE connection_id = ? AND key = 'gmail_history_id'`
      )
      .get(connectionId) as { value_json: string };
    expect(JSON.parse(cursor.value_json)).toStrictEqual({ id: "42017" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("a failed Gmail baseline degrades safely but is logged, never silently swallowed", async () => {
    const plane = openPlane(await tempDir());
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request) => {
        if (String(input).includes("gmail.googleapis.com")) {
          // The profile call blows up: the connection still works (the first poll
          // re-baselines), but a swallowed fallible action must at least warn
          // (docs/coding-standards.md).
          throw new Error("gmail profile unreachable");
        }
        return Response.json({
          access_token: "fresh-gmail-token",
          refresh_token: "refresh-gmail-token",
          expires_in: 3600,
        });
      }
    );
    const warnings: string[] = [];
    const connectionId = configureOauth(
      plane,
      "https://oauth2.googleapis.com/token"
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      undefined,
      fetchImpl as typeof fetch,
      undefined,
      { ...silentLogger, warn: (message: string) => warnings.push(message) }
    );
    const ceremony = broker.beginAuthorization(
      plane,
      connectionId,
      "http://127.0.0.1/oauth/callback"
    );
    // The ceremony still completes — the baseline is best-effort.
    await expect(
      broker.completeAuthorization(ceremony.state, "authorization-code")
    ).resolves.toStrictEqual({ connectionId });
    expect(warnings).toStrictEqual([
      expect.stringContaining("Gmail history baseline failed"),
    ]);
    expect(warnings[0]).toContain("gmail profile unreachable");
    // No baseline cursor landed, so the first poll re-baselines.
    const cursor = plane.db.vault
      .prepare(
        `SELECT value_json FROM sync_connection_cursor
        WHERE connection_id = ? AND key = 'gmail_history_id'`
      )
      .get(connectionId);
    expect(cursor).toBeUndefined();
  });

  test("Assist refresh uses only the Worker and persists a rotated pair before use", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureAssist(plane);
    storeTokens(plane, connectionId, {
      access_token: "ya29.assist-stale",
      refresh_token: "1//assist-original",
      refresh_capability: "cap-for-original",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          access_token: "ya29.assist-fresh",
          refresh_token: "1//assist-rotated",
          refresh_capability: "cap-for-rotated",
          expires_in: 3600,
        });
      }
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    const auth = await broker.resolveForFire({
      kind: "pull.gcal",
      label: "Centraid Assist",
    });
    expect(auth && "values" in auth ? auth.values : undefined).toStrictEqual({
      access_token: "ya29.assist-fresh",
    });
    expect(requests).toStrictEqual([
      {
        path: "/refresh",
        body: {
          provider: "google",
          refresh_token: "1//assist-original",
          refresh_capability: "cap-for-original",
        },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("client_secret");
    const row = connectionRow(plane, connectionId);
    expect(String(row.access_token)).toMatch(/^sealed:v1:/u);
    expect(String(row.refresh_token)).toMatch(/^sealed:v1:/u);
  });

  // Issue #865 regression: the capability round-trips sealed at rest —
  // stored beside the refresh token, unsealed only to be sent to the Worker,
  // and re-stored when Google rotates the pair.
  test("the Assist refresh capability round-trips sealed: stored, sent, rotated, re-stored", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureAssist(plane);
    storeTokens(plane, connectionId, {
      access_token: "ya29.stale",
      refresh_token: "1//original",
      refresh_capability: "cap-v1",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const requests: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        call += 1;
        return Response.json(
          call === 1
            ? {
                access_token: "ya29.fresh",
                refresh_token: "1//rotated",
                refresh_capability: "cap-v2",
                expires_in: 3600,
              }
            : { access_token: "ya29.again", expires_in: 3600 }
        );
      }
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    await broker.resolveForFire({
      kind: "pull.gcal",
      label: "Centraid Assist",
    });
    expect(requests[0]).toMatchObject({ refresh_capability: "cap-v1" });
    const capabilityOf = (): string =>
      (
        plane.db.vault
          .prepare(
            "SELECT refresh_capability FROM sync_connection_credential WHERE connection_id = ?"
          )
          .get(connectionId) as { refresh_capability: string }
      ).refresh_capability;
    // The rotated capability persisted sealed with the rotated token.
    const storedCipher = capabilityOf();
    expect(storedCipher).toMatch(/^sealed:v1:/u);
    expect(
      unsealValue(
        plane.db.sealKey,
        sealAad(
          "sync_connection_credential",
          "refresh_capability",
          connectionId
        ),
        storedCipher
      )
    ).toBe("cap-v2");
    // The NEXT refresh presents the re-stored capability for the rotated token.
    await broker.ensureFreshToken(plane, connectionId, true);
    expect(requests[1]).toMatchObject({
      refresh_token: "1//rotated",
      refresh_capability: "cap-v2",
    });
  });

  test("an Assist pair without its refresh capability is auth-dead (reconnect required)", async () => {
    const plane = openPlane(await tempDir());
    const connectionId = configureAssist(plane);
    storeTokens(plane, connectionId, {
      access_token: "ya29.legacy",
      refresh_token: "1//legacy-no-capability",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "missing_capability" }, { status: 401 })
    );
    const broker = new ConnectionBroker(
      () => plane,
      500,
      {
        workerBaseUrl: ASSIST_DEVELOPMENT_WORKER_ORIGIN,
        googleClientId: "centraid-shared.apps.googleusercontent.com",
        restrictedScopesEnabled: false,
      },
      fetchImpl as typeof fetch
    );
    const auth = await broker.resolveForFire({
      kind: "pull.gcal",
      label: "Centraid Assist",
    });
    expect(auth && "refused" in auth ? auth.refused : undefined).toMatch(
      /missing_capability/u
    );
    const row = connectionRow(plane, connectionId);
    expect(row.status).toBe("needs-auth");
    expect(String(row.auth_note)).toMatch(/Reconnect/u);
  });
});
