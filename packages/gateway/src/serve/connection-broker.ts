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

import { sealAad, unsealValue, type InvokeOutcome } from '@centraid/vault';
import type { ConnectionAuth, ResolveConnection } from '@centraid/automation';
import type { VaultPlane } from './vault-plane.js';

/** Purpose stamped on the broker's own vault acts. */
const BROKER_PURPOSE = 'dpv:ServiceProvision';

/** Refresh when the stored token has less than this long to live. */
const EXPIRY_SLACK_MS = 60 * 1000;

/** One transient retry before a refresh gives up for this fire. */
const TRANSIENT_RETRY_DELAY_MS = 500;

interface ConnectionCredRow {
  connection_id: string;
  cred_kind: 'oauth2' | 'api_key' | null;
  token_url: string | null;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  token_expires_at: string | null;
  allowed_hosts: string | null;
}

/** The credential is dead upstream — needs a new consent ceremony. */
class AuthDeadError extends Error {}

/**
 * Tiny per-connection rate gate: at most `maxConcurrent` injected requests
 * in flight and `minIntervalMs` between request STARTS, shared across every
 * fire on the connection — several automations on one Google connection
 * queue here instead of stampeding one quota (issue #304 decision 5).
 */
class ConnectionLimiter {
  private inFlight = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly maxConcurrent = 2,
    private readonly minIntervalMs = 250,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastStart = Date.now();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ConnectionBroker {
  /** Single-flight refresh per `<vaultId>:<connectionId>` (rot point 2). */
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly limiters = new Map<string, ConnectionLimiter>();

  constructor(private readonly planeFor: () => VaultPlane) {}

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
      return { refused: `connection "${connector.label}" carries a credential but no allowed_hosts pin` };
    }
    const limiter = this.limiterFor(plane, row.connection_id);
    const limit = <T,>(fn: () => Promise<T>): Promise<T> => limiter.run(fn);
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
      await this.flipNeedsAuth(plane, connectionId, 'no refresh token on record — run Connect');
      throw new AuthDeadError('no refresh token on record');
    }
    if (!row.token_url || !row.client_id) {
      await this.flipNeedsAuth(plane, connectionId, 'credential is missing token_url/client_id');
      throw new AuthDeadError('credential is missing token_url/client_id');
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.unseal(plane, connectionId, 'refresh_token', row.refresh_token),
      client_id: row.client_id,
    });
    if (row.client_secret) {
      form.set('client_secret', this.unseal(plane, connectionId, 'client_secret', row.client_secret));
    }

    const response = await this.postTokenForm(row.token_url, form);
    if (!response.ok && response.authDead) {
      // Rot point 3: invalid_grant et al. — the refresh token is dead, only
      // a new consent ceremony revives this connection.
      await this.flipNeedsAuth(
        plane,
        connectionId,
        `token refresh refused (${response.detail}) — reconnect to re-authorize`,
      );
      throw new AuthDeadError(`token refresh refused: ${response.detail}`);
    }
    if (!response.ok) {
      throw new Error(`token refresh failed transiently: ${response.detail}`);
    }
    const { accessToken, refreshToken, expiresAt } = response;
    // Rot point 1: persist BEFORE first use — receipted, sealed by the
    // command pipeline, journal-redacted via sealedInput.
    const outcome: InvokeOutcome = plane.gateway.invoke(plane.ownerCredential, {
      command: 'sync.store_tokens',
      input: {
        connection_id: connectionId,
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      },
      purpose: BROKER_PURPOSE,
    });
    if (outcome.status !== 'executed') {
      throw new Error(
        `refreshed tokens did not persist (${outcome.status}: ${'reason' in outcome ? outcome.reason : 'unknown'}) — refusing to use an unpersisted token`,
      );
    }
    return accessToken;
  }

  /**
   * One token-endpoint POST with a single transient retry. Distinguishes
   * auth-dead (4xx with an OAuth error body) from transient (network/5xx).
   */
  private async postTokenForm(
    tokenUrl: string,
    form: URLSearchParams,
  ): Promise<
    | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
    | { ok: false; authDead: boolean; detail: string }
  > {
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        status = res.status;
        text = await res.text();
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
        return { ok: false, authDead: false, detail: 'token endpoint answered without access_token' };
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

  /** needs-auth with a reason — the ONE actionable reconnect state. */
  private async flipNeedsAuth(plane: VaultPlane, connectionId: string, note: string): Promise<void> {
    plane.gateway.invoke(plane.ownerCredential, {
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
    connector: { kind: string; label: string },
  ): ConnectionCredRow | undefined {
    // No credential sidecar row = the harness-ambient lane (issue #290).
    return plane.db.vault
      .prepare(
        `SELECT cc.connection_id, cc.cred_kind, cc.token_url, cc.client_id, cc.client_secret,
                cc.access_token, cc.refresh_token, cc.api_key, cc.token_expires_at, cc.allowed_hosts
           FROM sync_connection_credential cc
           JOIN sync_connection c ON c.connection_id = cc.connection_id
          WHERE c.kind = ? AND c.label = ?`,
      )
      .get(connector.kind, connector.label) as ConnectionCredRow | undefined;
  }

  private readRowById(plane: VaultPlane, connectionId: string): ConnectionCredRow | undefined {
    return plane.db.vault
      .prepare(`SELECT * FROM sync_connection_credential WHERE connection_id = ?`)
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
