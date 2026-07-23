// governance: allow-repo-hygiene file-size-limit the broker core is one
// connection lifecycle — resolve → single-flight refresh → placeholder
// injection → the PKCE consent ceremony — held together by the three
// rot-point defenses below; the rate gate + auth-dead helper already live in
// connection-limiter.ts, and splitting the lifecycle itself would scatter
// the token-correctness invariants across files.
/**
 * The connection broker (issue #304) — the gateway-side owner of
 * broker-carried credentials. Where issue #290 decision 4 made the gateway
 * a broker over HARNESS-ambient credentials (resolve/pin/allowlist/
 * liveness), this module extends the same brokerage to credentials the
 * connection row itself carries: `oauth2` (the owner's BYO client) and
 * `api_key` (a static PAT), both sealed columns on `sync_connection`.
 *
 * The one law: **injection only, never handout.** Connector code refers to
 * `{{connection:access_token}}` / `{{connection:api_key}}` placeholders in
 * `ctx.fetch`; the plaintext substitutes parent-side of the worker boundary
 * (`@centraid/automation`'s runner) and only toward the connection's pinned
 * `allowed_hosts`. Nothing here ever returns a token to handler code.
 *
 * Token lifecycle correctness — the three known rot points, each with a
 * named defense (issue #304 decision 4):
 *   1. rotating refresh tokens: the rotated pair persists (receipted,
 *      through `sync.store_tokens`) BEFORE the new access token is used;
 *   2. concurrent refresh races: one single-flight refresh per connection —
 *      concurrent fires join the same promise, so a rotating provider never
 *      sees two competing refresh calls;
 *   3. real death vs transient failure: an `invalid_grant`-shaped refusal
 *      flips the connection to `needs-auth` with an owner-readable note
 *      (ONE actionable state, no 401 flood — dependent automations skip via
 *      honest liveness); a network/5xx failure retries once and then skips
 *      the fire WITHOUT flipping, because the next fire may simply succeed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { sealAad, unsealValue, type InvokeOutcome } from '@centraid/vault';
import type { ConnectionAuth, ResolveConnection } from '@centraid/automation';
import type { VaultPlane } from './vault-plane.js';
import { authDeadError, ConnectionLimiter, delay } from './connection-limiter.js';
import { timeoutSignal } from './fetch-timeout.js';
import {
  ASSIST_GOOGLE_AUTH_URL,
  assistCallbackUrl,
  assistScopes,
  validateAssistOAuthConfig,
  type AssistOAuthConfig,
} from './assist-oauth.js';

/** Purpose stamped on the broker's own vault acts. */
const BROKER_PURPOSE = 'dpv:ServiceProvision';

/** Refresh when the stored token has less than this long to live. */
const EXPIRY_SLACK_MS = 60 * 1000;

/** One transient retry before a refresh gives up for this fire. */
const TRANSIENT_RETRY_DELAY_MS = 500;

/**
 * Bound on one token-endpoint POST (issue #351 Tier 4 hygiene) — a hung IdP
 * would otherwise wedge whatever awaits the refresh (a fire, the outbox
 * drain) indefinitely. A timeout rejects the `fetch` exactly like a dropped
 * connection would, so it rides the existing transient-failure path below
 * (retry once, then give up for this fire WITHOUT flipping the connection).
 */
export const TOKEN_ENDPOINT_TIMEOUT_MS = 30_000;

interface ConnectionCredRow {
  connection_id: string;
  cred_kind: 'oauth2' | 'api_key' | null;
  oauth_mode: 'byo' | 'assist';
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

/** One in-flight consent ceremony, keyed by its single-use `state`. */
interface PendingCeremony {
  mode: 'byo' | 'assist';
  plane: VaultPlane;
  connectionId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  /** Assist only: never placed in the authorization URL. */
  clientSessionId?: string;
  /** Assist only: enrolled transport identity, or null for admin/loopback. */
  deviceKey?: string | null;
  /**
   * Assist only: one-ceremony browser binding. It is delivered in the
   * Worker's scrubbed `/start` fragment, never in Google's authorization URL.
   */
  browserBinding?: string;
  /** Assist only: exact allowlisted scopes expected back from Google. */
  requestedScopes?: readonly string[];
}

/** A ceremony the owner walked away from is dead after ten minutes. */
const CEREMONY_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

type TokenResponse =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; authDead: boolean; detail: string };

export class ConnectionBroker {
  /** Single-flight refresh per `<vaultId>:<connectionId>` (rot point 2). */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly limiters = new Map<string, ConnectionLimiter>();
  /** In-flight consent ceremonies, single-use, TTL-bound. */
  private readonly pending = new Map<string, PendingCeremony>();
  private readonly assistOAuth?: AssistOAuthConfig;

  constructor(
    private readonly planeFor: () => VaultPlane,
    /** Overridable for tests; production callers take the default. */
    private readonly tokenTimeoutMs: number = TOKEN_ENDPOINT_TIMEOUT_MS,
    assistOAuth?: AssistOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    // Defense in depth: every caller, including embedders that bypass the
    // environment parser, gets the same fixed-origin validation before a
    // refresh token can ever be posted.
    this.assistOAuth = assistOAuth ? validateAssistOAuthConfig(assistOAuth) : undefined;
  }

  /**
   * Start the consent ceremony (issue #304 decision 3): mint the PKCE
   * verifier + single-use `state` and build the provider consent URL. The
   * `state` is the capability the (bearer-free) callback authenticates by.
   * `access_type=offline&prompt=consent` are Google's knobs for issuing a
   * refresh token — other providers ignore them.
   */
  beginAuthorization(
    plane: VaultPlane,
    connectionId: string,
    redirectUri: string,
  ): { authUrl: string; state: string } {
    const row = this.readRowById(plane, connectionId);
    if (!row || row.cred_kind !== 'oauth2') {
      throw new Error('connection carries no oauth2 credential — configure one first');
    }
    if (!row.auth_url || !row.client_id) {
      throw new Error('oauth2 credential is missing auth_url/client_id');
    }
    this.pruneCeremonies();
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(row.auth_url);
    url.searchParams.set('client_id', row.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    if (row.scopes) url.searchParams.set('scope', row.scopes);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    this.pending.set(state, {
      mode: 'byo',
      plane,
      connectionId,
      verifier,
      redirectUri,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { authUrl: url.toString(), state };
  }

  /**
   * Start Model-B Assist. The gateway alone owns state + PKCE verifier.
   * The state prefix is a non-authorizing return-surface hint the stateless
   * Worker may read; the random remainder and every validation decision stay
   * gateway-owned.
   */
  beginAssistAuthorization(input: {
    plane: VaultPlane;
    connectionId: string;
    clientSessionId: string;
    deviceKey?: string;
    surface: 'desktop' | 'web';
  }): { authUrl: string; state: string; redirectUri: string } {
    const config = this.assistOAuth;
    if (!config) throw new Error('Centraid Assist is not configured on this gateway');
    const row = this.readRowById(input.plane, input.connectionId);
    if (!row || row.cred_kind !== 'oauth2' || row.oauth_mode !== 'assist') {
      throw new Error('connection is not configured for Centraid Assist');
    }
    this.pruneCeremonies();
    const state = `${input.surface === 'desktop' ? 'd' : 'w'}.${randomBytes(32).toString('base64url')}`;
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const browserBinding = randomBytes(32).toString('base64url');
    const redirectUri = assistCallbackUrl(config);
    const requestedScopes = assistScopes((row.scopes ?? '').split(/\s+/).filter(Boolean), config);
    const googleUrl = new URL(ASSIST_GOOGLE_AUTH_URL);
    googleUrl.searchParams.set('client_id', config.googleClientId);
    googleUrl.searchParams.set('redirect_uri', redirectUri);
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', requestedScopes.join(' '));
    googleUrl.searchParams.set('code_challenge', challenge);
    googleUrl.searchParams.set('code_challenge_method', 'S256');
    googleUrl.searchParams.set('state', state);
    googleUrl.searchParams.set('access_type', 'offline');
    googleUrl.searchParams.set('prompt', 'consent');
    if (row.principal) googleUrl.searchParams.set('login_hint', row.principal);
    const startUrl = new URL('/start', `${config.workerBaseUrl}/`);
    startUrl.hash = new URLSearchParams({
      authorization_url: googleUrl.toString(),
      browser_binding: browserBinding,
    }).toString();
    this.pending.set(state, {
      mode: 'assist',
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

  /**
   * Finish the ceremony: the provider bounced the owner's browser back with
   * `code` + `state`. The state must match a live pending entry (single-use
   * — consumed even on failure); the code exchanges at the token endpoint
   * with the PKCE verifier, and the pair lands via `sync.store_tokens`
   * (receipted, sealed, connection flips active).
   */
  async completeAuthorization(state: string, code: string): Promise<{ connectionId: string }> {
    const ceremony = this.pending.get(state);
    if (!ceremony || ceremony.expiresAt < this.now() || ceremony.mode !== 'byo') {
      if (ceremony?.expiresAt && ceremony.expiresAt < this.now()) this.pending.delete(state);
      throw new Error('unknown or expired authorization state — start Connect again');
    }
    this.pending.delete(state);
    const { plane, connectionId } = ceremony;
    const row = this.readRowById(plane, connectionId);
    if (!row || row.cred_kind !== 'oauth2' || !row.token_url || !row.client_id) {
      throw new Error('the connection lost its oauth2 credential mid-ceremony');
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ceremony.redirectUri,
      client_id: row.client_id,
      code_verifier: ceremony.verifier,
    });
    if (row.client_secret) {
      form.set(
        'client_secret',
        this.unseal(plane, connectionId, 'client_secret', row.client_secret),
      );
    }
    const response = await this.postTokenForm(row.token_url, form);
    if (!response.ok) {
      throw new Error(`authorization code exchange failed: ${response.detail}`);
    }
    await this.persistTokens(plane, connectionId, response, 'tokens did not persist');
    return { connectionId };
  }

  /**
   * Redeem an Assist courier handoff. Binding checks happen before state is
   * consumed so a copied fragment from another client/device cannot burn the
   * owner's live ceremony. A valid bound attempt is single-use even if the
   * Worker or Google later refuses it.
   */
  async completeAssistAuthorization(input: {
    state: string;
    code: string;
    receipt: string;
    clientSessionId: string;
    deviceKey?: string;
  }): Promise<{ connectionId: string }> {
    const config = this.assistOAuth;
    if (!config) throw new Error('Centraid Assist is not configured on this gateway');
    const ceremony = this.pending.get(input.state);
    if (!ceremony || ceremony.mode !== 'assist' || ceremony.expiresAt < this.now()) {
      if (ceremony?.expiresAt && ceremony.expiresAt < this.now()) this.pending.delete(input.state);
      throw new Error('unknown or expired authorization state — start Connect again');
    }
    if (
      ceremony.clientSessionId !== input.clientSessionId ||
      ceremony.deviceKey !== (input.deviceKey ?? null)
    ) {
      throw new Error('authorization handoff belongs to a different client session');
    }
    this.pending.delete(input.state);
    const row = this.readRowById(ceremony.plane, ceremony.connectionId);
    if (!row || row.cred_kind !== 'oauth2' || row.oauth_mode !== 'assist') {
      throw new Error('the connection lost its Assist credential mid-ceremony');
    }
    const response = await this.postAssist('/exchange', {
      provider: 'google',
      code: input.code,
      code_verifier: ceremony.verifier,
      redirect_uri: ceremony.redirectUri,
      receipt: input.receipt,
      state: input.state,
      browser_binding: ceremony.browserBinding,
      scopes: ceremony.requestedScopes,
    });
    if (!response.ok) {
      if (response.authDead) {
        await this.flipNeedsAuth(
          ceremony.plane,
          ceremony.connectionId,
          `Centraid Assist authorization failed (${response.detail}) — Reconnect with Centraid Assist`,
        );
      }
      throw new Error(`authorization code exchange failed: ${response.detail}`);
    }
    await this.persistTokens(
      ceremony.plane,
      ceremony.connectionId,
      response,
      'tokens did not persist',
    );
    return { connectionId: ceremony.connectionId };
  }

  /** Consume a denied/abandoned ceremony without ever attempting exchange. */
  cancelAuthorization(input: {
    state: string;
    clientSessionId?: string;
    deviceKey?: string;
  }): void {
    const ceremony = this.pending.get(input.state);
    if (!ceremony) return;
    if (ceremony.mode === 'assist') {
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
   * The per-fire seam `runFire` calls (issue #304): resolve the connector's
   * connection to injectable values. `undefined` = the connection carries
   * no broker credential (harness-ambient lane, pre-#304 behavior).
   */
  resolveForFire: ResolveConnection = async (
    connector,
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
    const limit = <T>(fn: () => Promise<T>): Promise<T> => limiter.run(fn);
    const onAuthDead = (reason: string): Promise<void> =>
      this.flipNeedsAuth(plane, row.connection_id, reason);

    if (row.cred_kind === 'api_key') {
      if (!row.api_key) {
        return { refused: `connection "${connector.label}" is api_key-kind but holds no key` };
      }
      return {
        values: { api_key: this.unseal(plane, row.connection_id, 'api_key', row.api_key) },
        allowedHosts,
        onAuthDead,
        limit,
      } satisfies ConnectionAuth;
    }

    // oauth2: make sure a live access token exists before the handler runs.
    try {
      const accessToken = await this.ensureFreshToken(plane, row.connection_id, false);
      return {
        values: { access_token: accessToken },
        allowedHosts,
        refresh: async () => ({
          access_token: await this.ensureFreshToken(plane, row.connection_id, true),
        }),
        onAuthDead,
        limit,
      } satisfies ConnectionAuth;
    } catch (err) {
      // AuthDead already flipped needs-auth; either way this fire skips.
      return {
        refused: `connection "${connector.label}" has no usable token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  /**
   * The outbox executor's seam (issue #306): resolve one connection to
   * injectable values on the WRITE lane. Same custody as `resolveForFire` —
   * injection only, host pin, single-flight refresh — plus `allowWrites`,
   * which connector fires never get: the only mutating injected requests in
   * the system are executor drains of owner-approved/grant-matched items.
   */
  async resolveForDrain(
    plane: VaultPlane,
    connectionId: string,
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
    if (row.cred_kind === 'api_key') {
      if (!row.api_key) {
        return { refused: `connection ${connectionId} is api_key-kind but holds no key` };
      }
      return {
        values: { api_key: this.unseal(plane, row.connection_id, 'api_key', row.api_key) },
        allowedHosts,
        onAuthDead,
        limit,
        allowWrites: true,
      } satisfies ConnectionAuth;
    }
    try {
      const accessToken = await this.ensureFreshToken(plane, row.connection_id, false);
      return {
        values: { access_token: accessToken },
        allowedHosts,
        refresh: async () => ({
          access_token: await this.ensureFreshToken(plane, row.connection_id, true),
        }),
        onAuthDead,
        limit,
        allowWrites: true,
      } satisfies ConnectionAuth;
    } catch (err) {
      return {
        refused: `connection ${connectionId} has no usable token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Resolve a live access token, refreshing when expired (or `force`, after
   * an upstream 401). Single-flight: concurrent callers of one connection
   * join the running refresh instead of racing it.
   */
  async ensureFreshToken(plane: VaultPlane, connectionId: string, force: boolean): Promise<string> {
    const key = `${plane.boot.vaultId}:${connectionId}`;
    const inflight = this.refreshing.get(key);
    if (inflight) return inflight;

    const row = this.readRowById(plane, connectionId);
    if (!row || row.cred_kind !== 'oauth2') {
      throw new Error(`connection ${connectionId} carries no oauth2 credential`);
    }
    if (!force && row.access_token && !expiringSoon(row.token_expires_at)) {
      return this.unseal(plane, connectionId, 'access_token', row.access_token);
    }
    const refresh = this.refreshTokens(plane, connectionId, row).finally(() => {
      this.refreshing.delete(key);
    });
    this.refreshing.set(key, refresh);
    return refresh;
  }

  /** POST the refresh grant, persist the (possibly rotated) pair, return the new access token. */
  private async refreshTokens(
    plane: VaultPlane,
    connectionId: string,
    row: ConnectionCredRow,
  ): Promise<string> {
    if (!row.refresh_token) {
      await this.flipNeedsAuth(
        plane,
        connectionId,
        row.oauth_mode === 'assist'
          ? 'No refresh token is available — Reconnect with Centraid Assist'
          : 'no refresh token on record — run Connect',
      );
      throw authDeadError('no refresh token on record');
    }
    if (!row.token_url || !row.client_id) {
      await this.flipNeedsAuth(plane, connectionId, 'credential is missing token_url/client_id');
      throw authDeadError('credential is missing token_url/client_id');
    }
    const refreshToken = this.unseal(plane, connectionId, 'refresh_token', row.refresh_token);
    const response =
      row.oauth_mode === 'assist'
        ? await this.postAssist('/refresh', { provider: 'google', refresh_token: refreshToken })
        : await this.postByoRefresh(row, connectionId, plane, refreshToken);
    if (!response.ok && response.authDead) {
      // Rot point 3: invalid_grant et al. — the refresh token is dead, only
      // a new consent ceremony revives this connection.
      await this.flipNeedsAuth(
        plane,
        connectionId,
        row.oauth_mode === 'assist'
          ? `Centraid Assist refresh refused (${response.detail}) — Reconnect with Centraid Assist`
          : `token refresh refused (${response.detail}) — reconnect to re-authorize`,
      );
      throw authDeadError(`token refresh refused: ${response.detail}`);
    }
    if (!response.ok) {
      throw new Error(`token refresh failed transiently: ${response.detail}`);
    }
    const { accessToken, refreshToken: rotatedRefreshToken, expiresAt } = response;
    // Rot point 1: persist BEFORE first use — receipted, sealed by the
    // command pipeline, journal-redacted via sealedInput.
    await this.persistTokens(
      plane,
      connectionId,
      {
        ok: true,
        accessToken,
        ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      'refreshed tokens did not persist',
      ' — refusing to use an unpersisted token',
    );
    return accessToken;
  }

  private async postByoRefresh(
    row: ConnectionCredRow,
    connectionId: string,
    plane: VaultPlane,
    refreshToken: string,
  ): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: row.client_id!,
    });
    if (row.client_secret) {
      form.set(
        'client_secret',
        this.unseal(plane, connectionId, 'client_secret', row.client_secret),
      );
    }
    return this.postTokenForm(row.token_url!, form);
  }

  /**
   * One token-endpoint POST with a single transient retry. Distinguishes
   * auth-dead (4xx with an OAuth error body) from transient (network/5xx).
   */
  private async postTokenForm(tokenUrl: string, form: URLSearchParams): Promise<TokenResponse> {
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const res = await this.fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: timeoutSignal(this.tokenTimeoutMs),
        });
        status = res.status;
        text = await readBoundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      } catch (err) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        return {
          ok: false,
          authDead: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (status >= 500 || status === 429) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        return { ok: false, authDead: false, detail: `token endpoint answered ${status}` };
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON error body — fall through to status handling */
      }
      if (status >= 400) {
        const code = typeof body.error === 'string' ? body.error : `http ${status}`;
        return { ok: false, authDead: true, detail: code };
      }
      const accessToken = body.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return {
          ok: false,
          authDead: false,
          detail: 'token endpoint answered without access_token',
        };
      }
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
      return {
        ok: true,
        accessToken,
        ...(typeof body.refresh_token === 'string' && body.refresh_token
          ? { refreshToken: body.refresh_token }
          : {}),
        ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
      };
    }
  }

  /** Stateless confidential-client hop; the gateway never receives a client secret. */
  private async postAssist(path: '/exchange' | '/refresh', body: unknown): Promise<TokenResponse> {
    const config = this.assistOAuth;
    if (!config) return { ok: false, authDead: false, detail: 'assist_not_configured' };
    const endpoint = new URL(path, `${config.workerBaseUrl}/`).toString();
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const res = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: timeoutSignal(this.tokenTimeoutMs),
        });
        status = res.status;
        text = await readBoundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      } catch (err) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        return {
          ok: false,
          authDead: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (status >= 500 || status === 429) {
        if (attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        return { ok: false, authDead: false, detail: `assist_worker_${status}` };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, authDead: false, detail: 'assist_worker_invalid_response' };
      }
      if (status >= 400) {
        const code = typeof parsed.error === 'string' ? parsed.error : `assist_worker_${status}`;
        return {
          ok: false,
          authDead:
            status === 400 &&
            ['invalid_grant', 'invalid_receipt', 'expired_receipt'].includes(code),
          detail: code,
        };
      }
      const accessToken = parsed.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { ok: false, authDead: false, detail: 'assist_worker_missing_access_token' };
      }
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined;
      return {
        ok: true,
        accessToken,
        ...(typeof parsed.refresh_token === 'string' && parsed.refresh_token
          ? { refreshToken: parsed.refresh_token }
          : {}),
        ...(expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
          : {}),
      };
    }
  }

  private async persistTokens(
    plane: VaultPlane,
    connectionId: string,
    response: Extract<TokenResponse, { ok: true }>,
    prefix: string,
    suffix = '',
  ): Promise<void> {
    const outcome: InvokeOutcome = await plane.invoke(plane.ownerCredential, {
      command: 'sync.store_tokens',
      input: {
        connection_id: connectionId,
        access_token: response.accessToken,
        ...(response.refreshToken ? { refresh_token: response.refreshToken } : {}),
        ...(response.expiresAt ? { expires_at: response.expiresAt } : {}),
      },
      purpose: BROKER_PURPOSE,
    });
    if (outcome.status !== 'executed') {
      throw new Error(
        `${prefix} (${outcome.status}: ${'reason' in outcome ? outcome.reason : 'unknown'})${suffix}`,
      );
    }
  }

  private pruneCeremonies(now = this.now()): void {
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(key);
    }
  }

  /** needs-auth with a reason — the ONE actionable reconnect state. */
  private async flipNeedsAuth(
    plane: VaultPlane,
    connectionId: string,
    note: string,
  ): Promise<void> {
    await plane.invoke(plane.ownerCredential, {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'needs-auth', note },
      purpose: BROKER_PURPOSE,
    });
  }

  private limiterFor(plane: VaultPlane, connectionId: string): ConnectionLimiter {
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
    connector: { kind: string; label: string; connectionId?: string },
  ): ConnectionCredRow | undefined {
    // Prefer durable connection id when the automation/manifest carries one.
    if (connector.connectionId) {
      return this.readRowById(plane, connector.connectionId);
    }
    // No credential sidecar row = the harness-ambient lane (issue #290).
    return plane.db.vault
      .prepare(
        `SELECT cc.connection_id, cc.cred_kind, cc.oauth_mode, cc.auth_url, cc.token_url, cc.scopes,
                cc.client_id, cc.client_secret, cc.access_token, cc.refresh_token,
                cc.api_key, cc.token_expires_at, cc.allowed_hosts, c.principal
           FROM sync_connection_credential cc
           JOIN sync_connection c ON c.connection_id = cc.connection_id
          WHERE c.kind = ? AND c.label = ?`,
      )
      .get(connector.kind, connector.label) as ConnectionCredRow | undefined;
  }

  private readRowById(plane: VaultPlane, connectionId: string): ConnectionCredRow | undefined {
    return plane.db.vault
      .prepare(
        `SELECT cc.*, c.principal
           FROM sync_connection_credential cc
           JOIN sync_connection c ON c.connection_id = cc.connection_id
          WHERE cc.connection_id = ?`,
      )
      .get(connectionId) as ConnectionCredRow | undefined;
  }

  /** Host-side unseal of one credential cell — never crosses to handler code. */
  private unseal(plane: VaultPlane, connectionId: string, column: string, value: string): string {
    return unsealValue(
      plane.db.sealKey,
      sealAad('sync_connection_credential', column, connectionId),
      value,
    );
  }
}

function parseHosts(json: string | null): readonly string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

function expiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false; // no recorded expiry — trust it until a 401 forces a refresh
  return Date.parse(expiresAt) - Date.now() < EXPIRY_SLACK_MS;
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('token endpoint response exceeded safety limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new Error('token endpoint response exceeded safety limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
