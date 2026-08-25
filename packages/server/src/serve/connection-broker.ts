// governance: allow-repo-hygiene file-size-limit the broker core is one
// connection lifecycle — resolve → single-flight refresh → placeholder
// injection → the PKCE consent ceremony — held together by the three
// rot-point defenses below; the rate gate + auth-dead helper already live in
// connection-limiter.ts, and splitting the lifecycle itself would scatter
// the token-correctness invariants across files.
/**
 * Connection broker (#304): oauth2 / api_key sealed on `sync_connection`.
 * Law: injection only, never handout — plaintext substitutes parent-side
 * toward pinned `allowed_hosts`. Never return a token to handler code.
 *
 * Rot points (#304 d4): (1) persist rotated pair BEFORE use; (2) single-flight
 * refresh; (3) `invalid_grant` → `needs-auth`; network/5xx retries once then
 * skips WITHOUT flipping.
 */

import { createHash, randomBytes } from "node:crypto";

import type {
  ConnectionAuth,
  ConnectionBinding,
  ResolveConnection,
} from "@centraid/server/automation";
import type { RuntimeLogger } from "@centraid/server/engine";
import { sealAad, unsealValue } from "@centraid/vault";
import type { InvokeOutcome } from "@centraid/vault";

import { PROVIDER_PRESETS } from "../routes/connection-providers.js";
import {
  ASSIST_GOOGLE_AUTH_URL,
  assistCallbackUrl,
  assistScopes,
  validateAssistOAuthConfig,
} from "./assist-oauth.js";
import type { AssistOAuthConfig } from "./assist-oauth.js";
import type { PollJsonResponse } from "./automation-event-sources.js";
import {
  authDeadError,
  ConnectionLimiter,
  delay,
} from "./connection-limiter.js";
import { timeoutSignal } from "./fetch-timeout.js";
import type { VaultPlane } from "./vault-plane.js";

const BROKER_PURPOSE = "dpv:ServiceProvision";
const EXPIRY_SLACK_MS = 60 * 1000;
const TRANSIENT_RETRY_DELAY_MS = 500;

/**
 * Token-endpoint POST bound (#351). Timeout rides the transient path
 * (retry once, then skip WITHOUT flipping).
 */
export const TOKEN_ENDPOINT_TIMEOUT_MS = 30_000;

interface ConnectionCredRow {
  connection_id: string;
  kind: string;
  label: string;
  provider: string | null;
  cred_kind: "oauth2" | "api_key" | null;
  oauth_mode: "byo" | "assist";
  auth_url: string | null;
  token_url: string | null;
  scopes: string | null;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  token_expires_at: string | null;
  allowed_hosts: string | null;
  principal: string | null;
}

function readOnlyPostsFor(
  row: ConnectionCredRow
): ConnectionAuth["readOnlyPosts"] {
  switch (`${row.provider ?? ""}:${row.kind}`) {
    case "dropbox:pull.dropbox":
      return [
        {
          host: "api.dropboxapi.com",
          path: "/2/users/get_current_account",
          body: "json",
        },
        {
          host: "api.dropboxapi.com",
          path: "/2/files/list_folder",
          body: "json",
        },
        {
          host: "api.dropboxapi.com",
          path: "/2/files/list_folder/continue",
          body: "json",
        },
      ];
    case "notion:pull.notion":
      return [{ host: "api.notion.com", path: "/v1/search", body: "json" }];
    case "linear:pull.linear":
      return [
        { host: "api.linear.app", path: "/graphql", body: "graphql-query" },
      ];
    default:
      return undefined;
  }
}

interface PendingCeremony {
  mode: "byo" | "assist";
  plane: VaultPlane;
  connectionId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  /** Assist: never placed in the authorization URL. */
  clientSessionId?: string;
  /** Assist: enrolled transport identity, or null for admin/loopback. */
  deviceKey?: string | null;
  /** Assist: Worker `/start` fragment — never in Google's authorization URL. */
  browserBinding?: string;
  /** Assist: exact allowlisted scopes expected back from Google. */
  requestedScopes?: readonly string[];
}

const CEREMONY_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

type TokenResponse =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; authDead: boolean; detail: string };

export class ConnectionBroker {
  /** Single-flight refresh per `<vaultId>:<connectionId>` (rot point 2). */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly limiters = new Map<string, ConnectionLimiter>();
  private readonly pending = new Map<string, PendingCeremony>();
  private readonly assistOAuth?: AssistOAuthConfig;

  constructor(
    private readonly planeFor: () => VaultPlane,
    private readonly tokenTimeoutMs: number = TOKEN_ENDPOINT_TIMEOUT_MS,
    assistOAuth?: AssistOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly logger?: RuntimeLogger
  ) {
    // Defense in depth: same fixed-origin validation even if the env parser is bypassed.
    this.assistOAuth = assistOAuth
      ? validateAssistOAuthConfig(assistOAuth)
      : undefined;
  }

  /**
   * Start consent (#304 d3): PKCE + single-use `state` (callback capability).
   * `access_type=offline&prompt=consent` are Google refresh-token knobs.
   */
  beginAuthorization(
    plane: VaultPlane,
    connectionId: string,
    redirectUri: string
  ): { authUrl: string; state: string } {
    const row = this.readRowById(plane, connectionId);
    if (!row || row.cred_kind !== "oauth2") {
      throw new Error(
        "connection carries no oauth2 credential — configure one first"
      );
    }
    if (!row.auth_url || !row.client_id) {
      throw new Error("oauth2 credential is missing auth_url/client_id");
    }
    const preset = PROVIDER_PRESETS.find(
      (candidate) => candidate.id === row.provider
    );
    if (
      preset?.credKind === "oauth2" &&
      (row.auth_url !== preset.authUrl || row.token_url !== preset.tokenUrl)
    ) {
      throw new Error(
        `connection provider "${preset.id}" does not match its trusted OAuth endpoints`
      );
    }
    this.pruneCeremonies();
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(row.auth_url);
    url.searchParams.set("client_id", row.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    if (row.scopes) url.searchParams.set("scope", row.scopes);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    this.pending.set(state, {
      mode: "byo",
      plane,
      connectionId,
      verifier,
      redirectUri,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { authUrl: url.toString(), state };
  }

  /**
   * Assist start. Gateway owns state + PKCE. State prefix is a non-authorizing
   * return-surface hint; validation stays gateway-owned.
   */
  beginAssistAuthorization(input: {
    plane: VaultPlane;
    connectionId: string;
    clientSessionId: string;
    deviceKey?: string;
    surface: "desktop" | "web";
  }): { authUrl: string; state: string; redirectUri: string } {
    const config = this.assistOAuth;
    if (!config)
      throw new Error("Centraid Assist is not configured on this gateway");
    const row = this.readRowById(input.plane, input.connectionId);
    if (!row || row.cred_kind !== "oauth2" || row.oauth_mode !== "assist") {
      throw new Error("connection is not configured for Centraid Assist");
    }
    this.pruneCeremonies();
    const state = `${input.surface === "desktop" ? "d" : "w"}.${randomBytes(32).toString("base64url")}`;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const browserBinding = randomBytes(32).toString("base64url");
    const redirectUri = assistCallbackUrl(config);
    const requestedScopes = assistScopes(
      (row.scopes ?? "").split(/\s+/u).filter(Boolean),
      config
    );
    const googleUrl = new URL(ASSIST_GOOGLE_AUTH_URL);
    googleUrl.searchParams.set("client_id", config.googleClientId);
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", requestedScopes.join(" "));
    googleUrl.searchParams.set("code_challenge", challenge);
    googleUrl.searchParams.set("code_challenge_method", "S256");
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");
    if (row.principal) googleUrl.searchParams.set("login_hint", row.principal);
    const startUrl = new URL("/start", `${config.workerBaseUrl}/`);
    startUrl.hash = new URLSearchParams({
      authorization_url: googleUrl.toString(),
      browser_binding: browserBinding,
    }).toString();
    this.pending.set(state, {
      mode: "assist",
      plane: input.plane,
      connectionId: input.connectionId,
      verifier,
      redirectUri,
      expiresAt: this.now() + CEREMONY_TTL_MS,
      clientSessionId: input.clientSessionId,
      deviceKey: input.deviceKey ?? null,
      browserBinding,
      requestedScopes,
    });
    return { authUrl: startUrl.toString(), state, redirectUri };
  }

  /** Finish BYO: single-use `state` (consumed even on failure); persist via `sync.store_tokens`. */
  async completeAuthorization(
    state: string,
    code: string
  ): Promise<{ connectionId: string }> {
    const ceremony = this.pending.get(state);
    if (
      !ceremony ||
      ceremony.expiresAt < this.now() ||
      ceremony.mode !== "byo"
    ) {
      if (ceremony?.expiresAt && ceremony.expiresAt < this.now())
        this.pending.delete(state);
      throw new Error(
        "unknown or expired authorization state — start Connect again"
      );
    }
    this.pending.delete(state);
    const { plane, connectionId } = ceremony;
    const row = this.readRowById(plane, connectionId);
    if (
      !row ||
      row.cred_kind !== "oauth2" ||
      !row.token_url ||
      !row.client_id
    ) {
      throw new Error("the connection lost its oauth2 credential mid-ceremony");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ceremony.redirectUri,
      client_id: row.client_id,
      code_verifier: ceremony.verifier,
    });
    if (row.client_secret) {
      form.set(
        "client_secret",
        this.unseal(plane, connectionId, "client_secret", row.client_secret)
      );
    }
    const response = await this.postTokenForm(row.token_url, form);
    if (!response.ok) {
      throw new Error(`authorization code exchange failed: ${response.detail}`);
    }
    await this.persistTokens(
      plane,
      connectionId,
      response,
      "tokens did not persist"
    );
    await this.warnOnBaselineFailure(
      this.captureGmailBaseline(plane, row, response.accessToken)
    );
    return { connectionId };
  }

  /**
   * Redeem Assist courier. Bind before consuming state so a copied fragment
   * cannot burn the live ceremony. Bound attempt is single-use even on later refusal.
   */
  async completeAssistAuthorization(input: {
    state: string;
    code: string;
    receipt: string;
    clientSessionId: string;
    deviceKey?: string;
  }): Promise<{ connectionId: string }> {
    const config = this.assistOAuth;
    if (!config)
      throw new Error("Centraid Assist is not configured on this gateway");
    const ceremony = this.pending.get(input.state);
    if (
      !ceremony ||
      ceremony.mode !== "assist" ||
      ceremony.expiresAt < this.now()
    ) {
      if (ceremony?.expiresAt && ceremony.expiresAt < this.now())
        this.pending.delete(input.state);
      throw new Error(
        "unknown or expired authorization state — start Connect again"
      );
    }
    if (
      ceremony.clientSessionId !== input.clientSessionId ||
      ceremony.deviceKey !== (input.deviceKey ?? null)
    ) {
      throw new Error(
        "authorization handoff belongs to a different client session"
      );
    }
    this.pending.delete(input.state);
    const row = this.readRowById(ceremony.plane, ceremony.connectionId);
    if (!row || row.cred_kind !== "oauth2" || row.oauth_mode !== "assist") {
      throw new Error("the connection lost its Assist credential mid-ceremony");
    }
    const response = await this.postAssist("/exchange", {
      provider: "google",
      code: input.code,
      code_verifier: ceremony.verifier,
      redirect_uri: ceremony.redirectUri,
      receipt: input.receipt,
      state: input.state,
      browser_binding: ceremony.browserBinding,
      scopes: ceremony.requestedScopes,
    });
    if (!response.ok) {
      // Additive until replacement tokens persist — a stale receipt must not
      // disable an already-working connection.
      if (response.authDead && !row.access_token && !row.refresh_token) {
        await this.flipNeedsAuth(
          ceremony.plane,
          ceremony.connectionId,
          `Centraid Assist authorization failed (${response.detail}) — Reconnect with Centraid Assist`
        );
      }
      throw new Error(`authorization code exchange failed: ${response.detail}`);
    }
    await this.persistTokens(
      ceremony.plane,
      ceremony.connectionId,
      response,
      "tokens did not persist"
    );
    await this.warnOnBaselineFailure(
      this.captureGmailBaseline(ceremony.plane, row, response.accessToken)
    );
    return { connectionId: ceremony.connectionId };
  }

  cancelAuthorization(input: {
    state: string;
    clientSessionId?: string;
    deviceKey?: string;
  }): void {
    const ceremony = this.pending.get(input.state);
    if (!ceremony) return;
    if (ceremony.mode === "assist") {
      if (
        ceremony.clientSessionId !== input.clientSessionId ||
        ceremony.deviceKey !== (input.deviceKey ?? null)
      ) {
        return;
      }
    }
    this.pending.delete(input.state);
  }

  /**
   * Per-fire seam (#304). `undefined` = no broker credential (harness-ambient).
   */
  resolveForFire: ResolveConnection = async (
    connector
  ): Promise<ConnectionAuth | { refused: string } | undefined> => {
    const plane = this.planeFor();
    const row = this.readRow(plane, connector);
    if (!row?.cred_kind) return undefined;
    const allowedHosts = parseHosts(row.allowed_hosts);
    if (allowedHosts.length === 0) {
      return {
        refused: `connection "${connector.label}" carries a credential but no allowed_hosts pin`,
      };
    }
    const limiter = this.limiterFor(plane, row.connection_id);
    const readOnlyPosts = readOnlyPostsFor(row);
    const limit = <T>(fn: () => Promise<T>): Promise<T> => limiter.run(fn);
    const onAuthDead = (reason: string): Promise<void> =>
      this.flipNeedsAuth(plane, row.connection_id, reason);

    if (row.cred_kind === "api_key") {
      if (!row.api_key) {
        return {
          refused: `connection "${connector.label}" is api_key-kind but holds no key`,
        };
      }
      return {
        values: {
          api_key: this.unseal(
            plane,
            row.connection_id,
            "api_key",
            row.api_key
          ),
        },
        allowedHosts,
        ...(readOnlyPosts ? { readOnlyPosts } : {}),
        onAuthDead,
        limit,
      } satisfies ConnectionAuth;
    }

    try {
      const accessToken = await this.ensureFreshToken(
        plane,
        row.connection_id,
        false
      );
      return {
        values: { access_token: accessToken },
        allowedHosts,
        ...(readOnlyPosts ? { readOnlyPosts } : {}),
        refresh: async () => ({
          access_token: await this.ensureFreshToken(
            plane,
            row.connection_id,
            true
          ),
        }),
        onAuthDead,
        limit,
      } satisfies ConnectionAuth;
    } catch (error) {
      return {
        refused: `connection "${connector.label}" has no usable token: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  /**
   * Bounded read-only JSON for event adapters. Adapter never receives a token:
   * host pin + inject + one 401-after-refresh retry.
   */
  async pollJson(
    connection: ConnectionBinding,
    rawUrl: string,
    requestHeaders: Readonly<Record<string, string>> = {}
  ): Promise<PollJsonResponse> {
    if (!connection.connectionId) {
      throw new Error("event polling requires a durable connectionId binding");
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "https:")
      throw new Error("provider event polling requires https");
    const resolved = await this.resolveForFire(connection);
    if (!resolved)
      throw new Error(
        `connection "${connection.label}" carries no broker credential`
      );
    if ("refused" in resolved) throw new Error(resolved.refused);
    if (!hostAllowed(url.hostname, resolved.allowedHosts)) {
      throw new Error(
        `provider host "${url.hostname}" is outside connection "${connection.label}" allowed_hosts`
      );
    }
    const safeHeaders = Object.fromEntries(
      Object.entries(requestHeaders).filter(
        ([name]) =>
          !["authorization", "cookie", "proxy-authorization"].includes(
            name.toLowerCase()
          )
      )
    );
    const perform = async (
      values: Readonly<Record<string, string>>
    ): Promise<Response> => {
      const token = values.access_token ?? values.api_key;
      if (!token)
        throw new Error(
          `connection "${connection.label}" has no injectable token`
        );
      return (resolved.limit ?? ((fn) => fn()))(() =>
        this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": "centraid-automation-events",
            ...safeHeaders,
            authorization: `Bearer ${token}`,
          },
          redirect: "error",
          signal: timeoutSignal(this.tokenTimeoutMs),
        })
      );
    };
    let response = await perform(resolved.values);
    if (response.status === 401 && resolved.refresh) {
      response = await perform(await resolved.refresh());
    }
    if (response.status === 401) {
      await resolved.onAuthDead?.(
        "provider event poll returned 401 — reconnect the account"
      );
    }
    const bodyText =
      response.status === 304
        ? ""
        : await readBoundedResponseText(
            response,
            MAX_PROVIDER_RESPONSE_BYTES,
            "provider response"
          );
    let body: unknown;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        throw new Error(
          `provider event poll returned non-JSON (${response.status})`
        );
      }
    }
    const headers: Record<string, string> = {};
    // Link is pagination, not credentials — preserve it for the page walk.
    for (const name of ["etag", "last-modified", "link", "x-poll-interval"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return {
      status: response.status,
      headers,
      ...(body === undefined ? {} : { body }),
    };
  }

  /**
   * Outbox write-lane seam (#306). Same custody as `resolveForFire` plus
   * `allowWrites` — connector fires never get this.
   */
  async resolveForDrain(
    plane: VaultPlane,
    connectionId: string
  ): Promise<ConnectionAuth | { refused: string }> {
    const row = this.readRowById(plane, connectionId);
    if (!row?.cred_kind) {
      return {
        refused: `connection ${connectionId} carries no broker credential — the outbox drains through broker-carried credentials only`,
      };
    }
    const allowedHosts = parseHosts(row.allowed_hosts);
    if (allowedHosts.length === 0) {
      return {
        refused: `connection ${connectionId} carries a credential but no allowed_hosts pin`,
      };
    }
    const limiter = this.limiterFor(plane, row.connection_id);
    const limit = <T>(fn: () => Promise<T>): Promise<T> => limiter.run(fn);
    const onAuthDead = (reason: string): Promise<void> =>
      this.flipNeedsAuth(plane, row.connection_id, reason);
    if (row.cred_kind === "api_key") {
      if (!row.api_key) {
        return {
          refused: `connection ${connectionId} is api_key-kind but holds no key`,
        };
      }
      return {
        values: {
          api_key: this.unseal(
            plane,
            row.connection_id,
            "api_key",
            row.api_key
          ),
        },
        allowedHosts,
        onAuthDead,
        limit,
        allowWrites: true,
      } satisfies ConnectionAuth;
    }
    try {
      const accessToken = await this.ensureFreshToken(
        plane,
        row.connection_id,
        false
      );
      return {
        values: { access_token: accessToken },
        allowedHosts,
        refresh: async () => ({
          access_token: await this.ensureFreshToken(
            plane,
            row.connection_id,
            true
          ),
        }),
        onAuthDead,
        limit,
        allowWrites: true,
      } satisfies ConnectionAuth;
    } catch (error) {
      return {
        refused: `connection ${connectionId} has no usable token: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Live access token; `force` after 401. Single-flight per connection. */
  async ensureFreshToken(
    plane: VaultPlane,
    connectionId: string,
    force: boolean
  ): Promise<string> {
    const key = `${plane.boot.vaultId}:${connectionId}`;
    const inflight = this.refreshing.get(key);
    if (inflight) return inflight;

    const row = this.readRowById(plane, connectionId);
    if (!row || row.cred_kind !== "oauth2") {
      throw new Error(
        `connection ${connectionId} carries no oauth2 credential`
      );
    }
    if (!force && row.access_token && !expiringSoon(row.token_expires_at)) {
      return this.unseal(plane, connectionId, "access_token", row.access_token);
    }
    const refresh = this.refreshTokens(plane, connectionId, row).finally(() => {
      this.refreshing.delete(key);
    });
    this.refreshing.set(key, refresh);
    return refresh;
  }

  private async refreshTokens(
    plane: VaultPlane,
    connectionId: string,
    row: ConnectionCredRow
  ): Promise<string> {
    if (!row.refresh_token) {
      await this.flipNeedsAuth(
        plane,
        connectionId,
        row.oauth_mode === "assist"
          ? "No refresh token is available — Reconnect with Centraid Assist"
          : "no refresh token on record — run Connect"
      );
      throw authDeadError("no refresh token on record");
    }
    if (!row.token_url || !row.client_id) {
      await this.flipNeedsAuth(
        plane,
        connectionId,
        "credential is missing token_url/client_id"
      );
      throw authDeadError("credential is missing token_url/client_id");
    }
    const refreshToken = this.unseal(
      plane,
      connectionId,
      "refresh_token",
      row.refresh_token
    );
    const response =
      row.oauth_mode === "assist"
        ? await this.postAssist("/refresh", {
            provider: "google",
            refresh_token: refreshToken,
          })
        : await this.postByoRefresh(row, connectionId, plane, refreshToken);
    if (!response.ok && response.authDead) {
      // Rot point 3: invalid_grant — only a new consent ceremony revives this.
      await this.flipNeedsAuth(
        plane,
        connectionId,
        row.oauth_mode === "assist"
          ? `Centraid Assist refresh refused (${response.detail}) — Reconnect with Centraid Assist`
          : `token refresh refused (${response.detail}) — reconnect to re-authorize`
      );
      throw authDeadError(`token refresh refused: ${response.detail}`);
    }
    if (!response.ok) {
      throw new Error(`token refresh failed transiently: ${response.detail}`);
    }
    const {
      accessToken,
      refreshToken: rotatedRefreshToken,
      expiresAt,
    } = response;
    // Rot point 1: persist BEFORE first use.
    await this.persistTokens(
      plane,
      connectionId,
      {
        ok: true,
        accessToken,
        ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      "refreshed tokens did not persist",
      " — refusing to use an unpersisted token"
    );
    return accessToken;
  }

  private async postByoRefresh(
    row: ConnectionCredRow,
    connectionId: string,
    plane: VaultPlane,
    refreshToken: string
  ): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: row.client_id!,
    });
    if (row.client_secret) {
      form.set(
        "client_secret",
        this.unseal(plane, connectionId, "client_secret", row.client_secret)
      );
    }
    return this.postTokenForm(row.token_url!, form);
  }

  /** One POST, one transient retry. Auth-dead (4xx OAuth) vs transient (network/5xx). */
  private async postTokenForm(
    tokenUrl: string,
    form: URLSearchParams
  ): Promise<TokenResponse> {
    const { fetchImpl, tokenTimeoutMs } = this;
    async function sendAttempt(attempt: number): Promise<TokenResponse> {
      let status: number;
      let text: string;
      try {
        const res = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          // Never follow a redirect with a code / refresh token / client secret.
          redirect: "error",
          signal: timeoutSignal(tokenTimeoutMs),
        });
        status = res.status;
        text = await readBoundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      } catch (error) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          return sendAttempt(attempt + 1);
        }
        return {
          ok: false,
          authDead: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (status >= 500 || status === 429) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          return sendAttempt(attempt + 1);
        }
        return {
          ok: false,
          authDead: false,
          detail: `token endpoint answered ${status}`,
        };
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON error body — fall through to status handling */
      }
      if (status >= 400) {
        const code =
          typeof body.error === "string" ? body.error : `http ${status}`;
        return { ok: false, authDead: true, detail: code };
      }
      const accessToken = body.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        return {
          ok: false,
          authDead: false,
          detail: "token endpoint answered without access_token",
        };
      }
      const expiresIn =
        typeof body.expires_in === "number" ? body.expires_in : undefined;
      return {
        ok: true,
        accessToken,
        ...(typeof body.refresh_token === "string" && body.refresh_token
          ? { refreshToken: body.refresh_token }
          : {}),
        ...(expiresIn
          ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
          : {}),
      };
    }
    return sendAttempt(0);
  }

  /** Confidential-client hop; the gateway never receives a client secret. */
  private async postAssist(
    path: "/exchange" | "/refresh",
    body: unknown
  ): Promise<TokenResponse> {
    const config = this.assistOAuth;
    if (!config)
      return { ok: false, authDead: false, detail: "assist_not_configured" };
    const { fetchImpl, tokenTimeoutMs } = this;
    const endpoint = new URL(path, `${config.workerBaseUrl}/`).toString();
    async function sendAttempt(attempt: number): Promise<TokenResponse> {
      let status: number;
      let text: string;
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: timeoutSignal(tokenTimeoutMs),
        });
        status = res.status;
        text = await readBoundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      } catch (error) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          return sendAttempt(attempt + 1);
        }
        return {
          ok: false,
          authDead: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (status >= 500 || status === 429) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          return sendAttempt(attempt + 1);
        }
        return {
          ok: false,
          authDead: false,
          detail: `assist_worker_${status}`,
        };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          authDead: false,
          detail: "assist_worker_invalid_response",
        };
      }
      if (status >= 400) {
        const code =
          typeof parsed.error === "string"
            ? parsed.error
            : `assist_worker_${status}`;
        return {
          ok: false,
          authDead:
            status === 400 &&
            ["invalid_grant", "invalid_receipt", "expired_receipt"].includes(
              code
            ),
          detail: code,
        };
      }
      const accessToken = parsed.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        return {
          ok: false,
          authDead: false,
          detail: "assist_worker_missing_access_token",
        };
      }
      const expiresIn =
        typeof parsed.expires_in === "number" ? parsed.expires_in : undefined;
      return {
        ok: true,
        accessToken,
        ...(typeof parsed.refresh_token === "string" && parsed.refresh_token
          ? { refreshToken: parsed.refresh_token }
          : {}),
        ...(expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
          : {}),
      };
    }
    return sendAttempt(0);
  }

  private async persistTokens(
    plane: VaultPlane,
    connectionId: string,
    response: Extract<TokenResponse, { ok: true }>,
    prefix: string,
    suffix = ""
  ): Promise<void> {
    const outcome: InvokeOutcome = await plane.invoke(plane.ownerCredential, {
      command: "sync.store_tokens",
      input: {
        connection_id: connectionId,
        access_token: response.accessToken,
        ...(response.refreshToken
          ? { refresh_token: response.refreshToken }
          : {}),
        ...(response.expiresAt ? { expires_at: response.expiresAt } : {}),
      },
      purpose: BROKER_PURPOSE,
    });
    if (outcome.status !== "executed") {
      throw new Error(
        `${prefix} (${outcome.status}: ${"reason" in outcome ? outcome.reason : "unknown"})${suffix}`
      );
    }
  }

  /** Missing Gmail baseline degrades; still log — don't swallow fallible work. */
  private async warnOnBaselineFailure(work: Promise<void>): Promise<void> {
    await work.catch((error: unknown) => {
      this.logger?.warn(
        `connection broker: Gmail history baseline failed (the first poll will re-baseline): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private async captureGmailBaseline(
    plane: VaultPlane,
    row: ConnectionCredRow,
    accessToken: string
  ): Promise<void> {
    if (row.provider !== "google" || row.kind !== "pull.gmail") return;
    const response = await this.fetchImpl(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        redirect: "error",
        signal: timeoutSignal(this.tokenTimeoutMs),
      }
    );
    if (!response.ok) return;
    const text = await readBoundedResponseText(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
      "Gmail profile response"
    );
    const historyId = stringField(JSON.parse(text) as unknown, "historyId");
    if (!historyId) return;
    const outcome = await plane.invoke(plane.ownerCredential, {
      command: "sync.set_cursor",
      input: {
        connection_id: row.connection_id,
        key: "gmail_history_id",
        value: { id: historyId },
      },
      purpose: BROKER_PURPOSE,
    });
    if (outcome.status !== "executed") {
      throw new Error("Gmail profile historyId did not persist");
    }
  }

  private pruneCeremonies(now = this.now()): void {
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(key);
    }
  }

  /** `needs-auth` with a reason — the one actionable reconnect state. */
  private async flipNeedsAuth(
    plane: VaultPlane,
    connectionId: string,
    note: string
  ): Promise<void> {
    await plane.invoke(plane.ownerCredential, {
      command: "sync.set_connection_status",
      input: { connection_id: connectionId, status: "needs-auth", note },
      purpose: BROKER_PURPOSE,
    });
  }

  private limiterFor(
    plane: VaultPlane,
    connectionId: string
  ): ConnectionLimiter {
    const key = `${plane.boot.vaultId}:${connectionId}`;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new ConnectionLimiter();
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  private readRow(
    plane: VaultPlane,
    connector: { kind: string; label: string; connectionId?: string }
  ): ConnectionCredRow | undefined {
    if (connector.connectionId) {
      const row = this.readRowById(plane, connector.connectionId);
      // Durable id survives label changes; cannot retarget another connector kind.
      return row?.kind === connector.kind ? row : undefined;
    }
    // No credential sidecar = harness-ambient lane (#290).
    return plane.db.vault
      .prepare(
        `SELECT cc.connection_id, c.kind, c.label, cc.provider,
                cc.cred_kind, cc.oauth_mode, cc.auth_url, cc.token_url, cc.scopes,
                cc.client_id, cc.client_secret, cc.access_token, cc.refresh_token,
                cc.api_key, cc.token_expires_at, cc.allowed_hosts, c.principal
           FROM sync_connection_credential cc
           JOIN sync_connection c ON c.connection_id = cc.connection_id
          WHERE c.kind = ? AND c.label = ?`
      )
      .get(connector.kind, connector.label) as ConnectionCredRow | undefined;
  }

  private readRowById(
    plane: VaultPlane,
    connectionId: string
  ): ConnectionCredRow | undefined {
    return plane.db.vault
      .prepare(
        `SELECT cc.*, c.kind, c.label, c.principal
           FROM sync_connection_credential cc
           JOIN sync_connection c ON c.connection_id = cc.connection_id
          WHERE cc.connection_id = ?`
      )
      .get(connectionId) as ConnectionCredRow | undefined;
  }

  /** Host-side unseal — never crosses to handler code. */
  private unseal(
    plane: VaultPlane,
    connectionId: string,
    column: string,
    value: string
  ): string {
    return unsealValue(
      plane.db.sealKey,
      sealAad("sync_connection_credential", column, connectionId),
      value
    );
  }
}

function parseHosts(json: string | null): readonly string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((h): h is string => typeof h === "string")
      : [];
  } catch {
    return [];
  }
}

function hostAllowed(
  hostname: string,
  allowedHosts: readonly string[]
): boolean {
  return allowedHosts.some((entry) =>
    entry.startsWith("*.")
      ? hostname.endsWith(entry.slice(1)) && hostname.length > entry.length - 1
      : hostname === entry
  );
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function expiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false; // no expiry recorded — trust until a 401
  return Date.parse(expiresAt) - Date.now() < EXPIRY_SLACK_MS;
}

interface BoundedResponseState {
  text: string;
  total: number;
}

async function readNextBoundedResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: BoundedResponseState,
  limit: number,
  label: string
): Promise<string> {
  const chunk = await reader.read();
  if (chunk.done) return state.text + decoder.decode();
  state.total += chunk.value.byteLength;
  if (state.total > limit) throw new Error(`${label} exceeded safety limit`);
  state.text += decoder.decode(chunk.value, { stream: true });
  return readNextBoundedResponseChunk(reader, decoder, state, limit, label);
}

async function readBoundedResponseText(
  response: Response,
  limit: number,
  label = "token endpoint response"
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`${label} exceeded safety limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    return await readNextBoundedResponseChunk(
      reader,
      decoder,
      { text: "", total: 0 },
      limit,
      label
    );
  } finally {
    reader.releaseLock();
  }
}
