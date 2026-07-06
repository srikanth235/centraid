/**
 * The outbox executor (issue #306 decision 3) — the ONLY path from an
 * outbox artifact to the network, and the only holder of the broker's
 * `allowWrites` lane. It runs OUTSIDE the fire loop: connector fires stage
 * items and stay read-only (issue #304's ceiling, untouched); the executor
 * drains only items the owner approved (or a standing grant matched), one
 * receipted `outbox.record_result` per drain — loop-safe by construction.
 *
 * The drain keeps every #304 injection invariant: `{{connection:…}}`
 * placeholders substitute HERE (tokens never sit in rows or cross to any
 * handler), the substituted URL must satisfy the connection's
 * `allowed_hosts` pin over https (loopback excepted for tests), redirects
 * are never auto-followed, and a 401 gets exactly one forced refresh.
 * Failure taxonomy per item:
 *   - 2xx → `sent` (terminal, receipted);
 *   - other 4xx → `failed` with the status + a scrubbed body snippet
 *     (terminal — a request the provider rejects won't improve by waiting);
 *   - 429/5xx/network → the item STAYS approved and retries next drain;
 *   - auth-dead (401 after refresh / scope-flavored 403) → needs-auth flips
 *     with a note and the item stays approved until the owner reconnects.
 */

import type { ConnectionAuth } from '@centraid/automation';
import type { RuntimeLogger } from '@centraid/app-engine';
import type { ConnectionBroker } from './connection-broker.js';
import type { VaultPlane } from './vault-plane.js';

const CONNECTION_REF_RE = /\{\{connection:([a-z_]+)\}\}/g;
const BODY_SNIPPET_CHARS = 300;

interface ApprovedRow {
  item_id: string;
  connection_id: string;
  verb: string;
  target: string;
  request_json: string;
}

interface StagedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DrainReport {
  approved: number;
  sent: number;
  failed: number;
  /** Items left approved for a later pass (needs-auth, transient upstream). */
  deferred: number;
}

export class OutboxExecutor {
  /** One drain at a time per vault — concurrent triggers join the running pass. */
  private readonly draining = new Map<string, Promise<DrainReport>>();

  constructor(
    private readonly broker: ConnectionBroker,
    private readonly logger: RuntimeLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  drain(plane: VaultPlane): Promise<DrainReport> {
    const key = plane.boot.vaultId;
    const inflight = this.draining.get(key);
    if (inflight) return inflight;
    const pass = this.drainPass(plane).finally(() => {
      this.draining.delete(key);
    });
    this.draining.set(key, pass);
    return pass;
  }

  private async drainPass(plane: VaultPlane): Promise<DrainReport> {
    const rows = plane.db.vault
      .prepare(
        `SELECT item_id, connection_id, verb, target, request_json
           FROM outbox_item WHERE status = 'approved' ORDER BY staged_at`,
      )
      .all() as unknown as ApprovedRow[];
    const report: DrainReport = { approved: rows.length, sent: 0, failed: 0, deferred: 0 };
    for (const row of rows) {
      try {
        const outcome = await this.drainItem(plane, row);
        report[outcome] += 1;
      } catch (err) {
        report.deferred += 1;
        this.logger.warn(
          `outbox: drain of ${row.item_id} (${row.verb}) errored, deferring: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    if (report.approved > 0) {
      this.logger.info(
        `outbox: drained vault ${plane.boot.vaultId} — sent=${report.sent} failed=${report.failed} deferred=${report.deferred}`,
      );
    }
    return report;
  }

  private async drainItem(
    plane: VaultPlane,
    row: ApprovedRow,
  ): Promise<'sent' | 'failed' | 'deferred'> {
    const auth = await this.broker.resolveForDrain(plane, row.connection_id);
    if ('refused' in auth) {
      // needs-auth (or unpinned) — the item waits for the owner's reconnect.
      this.logger.warn(`outbox: ${row.item_id} deferred — ${auth.refused}`);
      return 'deferred';
    }
    let spec: StagedRequest;
    let injectedSpec: StagedRequest;
    try {
      spec = parseRequest(row.request_json);
      injectedSpec = substitute(spec, auth.values);
      assertDrainable(injectedSpec.url, auth);
    } catch (err) {
      // Structural refusals (bad request row, host outside the pin) are
      // terminal: waiting will not move the pin.
      this.recordResult(plane, row.item_id, 'failed', undefined, errText(err, auth));
      return 'failed';
    }
    let refreshed = false;
    for (;;) {
      let response: { status: number; text: string };
      try {
        response = await this.fetchOnce(injectedSpec, auth);
      } catch (err) {
        this.logger.warn(
          `outbox: ${row.item_id} network failure, deferring: ${errText(err, auth)}`,
        );
        return 'deferred';
      }
      if (response.status === 401 && auth.refresh && !refreshed) {
        refreshed = true;
        try {
          injectedSpec = substitute(spec, await auth.refresh());
          // Re-assert the pin on the RE-substituted URL: a placeholder in
          // the URL means new values can move the destination.
          assertDrainable(injectedSpec.url, auth);
          continue;
        } catch (err) {
          this.logger.warn(`outbox: ${row.item_id} token refresh refused: ${errText(err, auth)}`);
          return 'deferred';
        }
      }
      if (
        response.status === 401 ||
        (response.status === 403 &&
          /insufficient.{0,4}(scope|permission)|invalid_scope/i.test(response.text))
      ) {
        await auth
          .onAuthDead?.(
            `outbox drain rejected (${response.status}) — reconnect to authorize external writes`,
          )
          .catch(() => undefined);
        return 'deferred';
      }
      if (response.status === 429 || response.status >= 500) {
        this.logger.warn(
          `outbox: ${row.item_id} upstream ${response.status}, deferring to next drain`,
        );
        return 'deferred';
      }
      const disposition = response.status < 300 ? 'sent' : 'failed';
      this.recordResult(
        plane,
        row.item_id,
        disposition,
        response.status,
        disposition === 'failed'
          ? scrub(response.text.slice(0, BODY_SNIPPET_CHARS), auth)
          : undefined,
      );
      return disposition;
    }
  }

  private async fetchOnce(
    spec: StagedRequest,
    auth: ConnectionAuth,
  ): Promise<{ status: number; text: string }> {
    const run = async (): Promise<{ status: number; text: string }> => {
      const response = await this.fetchImpl(spec.url, {
        method: spec.method,
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.body !== undefined ? { body: spec.body } : {}),
        // Injected requests never auto-follow: a cross-host Location would
        // carry the Authorization header past the pin (issue #304).
        redirect: 'manual',
      });
      return { status: response.status, text: await response.text() };
    };
    return auth.limit ? auth.limit(run) : run();
  }

  private recordResult(
    plane: VaultPlane,
    itemId: string,
    disposition: 'sent' | 'failed',
    statusCode?: number,
    detail?: string,
  ): void {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: 'outbox.record_result',
      input: {
        item_id: itemId,
        disposition,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(detail !== undefined ? { detail } : {}),
      },
    });
    if (outcome.status !== 'executed') {
      this.logger.warn(
        `outbox: result for ${itemId} did not record (${outcome.status}: ${'reason' in outcome ? outcome.reason : 'unknown'})`,
      );
    }
  }
}

function parseRequest(json: string): StagedRequest {
  const parsed = JSON.parse(json) as Partial<StagedRequest>;
  if (typeof parsed.method !== 'string' || typeof parsed.url !== 'string') {
    throw new Error('outbox request row is missing method/url');
  }
  return parsed as StagedRequest;
}

/** `{{connection:name}}` → plaintext, url + headers + body. Unknown names throw. */
function substitute(spec: StagedRequest, values: Readonly<Record<string, string>>): StagedRequest {
  const sub = (text: string): string =>
    text.replace(CONNECTION_REF_RE, (_, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`connection credential has no "${name}" value`);
      }
      return value;
    });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = sub(v);
  return {
    method: spec.method,
    url: sub(spec.url),
    ...(spec.headers ? { headers } : {}),
    ...(spec.body !== undefined ? { body: sub(spec.body) } : {}),
  };
}

/** The #304 pin, executor-side: https (loopback excepted) + allowed_hosts. */
function assertDrainable(rawUrl: string, auth: ConnectionAuth): void {
  const url = new URL(rawUrl);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(`outbox drain refuses non-https destination ${url.hostname}`);
  }
  const allowed = auth.allowedHosts.some((entry) =>
    entry.startsWith('*.')
      ? url.hostname.endsWith(entry.slice(1)) && url.hostname.length > entry.length - 1
      : url.hostname === entry,
  );
  if (!allowed) {
    throw new Error(
      `host "${url.hostname}" is outside this connection's allowed_hosts — the credential is pinned to ${auth.allowedHosts.join(', ')}`,
    );
  }
}

/** No credential value ever reaches a receipt or a log line. */
function scrub(text: string, auth: ConnectionAuth): string {
  let out = text;
  for (const value of Object.values(auth.values)) {
    if (value) out = out.replaceAll(value, '«secret»');
  }
  return out;
}

function errText(err: unknown, auth: ConnectionAuth): string {
  return scrub(err instanceof Error ? err.message : String(err), auth);
}
