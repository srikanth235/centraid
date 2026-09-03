import type { ConnectionAuth } from "@centraid/server/automation";
import type { RuntimeLogger } from "@centraid/server/engine";

import type { ConnectionBroker } from "./connection-broker.js";
import { timeoutSignal } from "./fetch-timeout.js";
import { noticeGist } from "./notices.js";
import type { VaultPlane } from "./vault-plane.js";

const CONNECTION_REF_RE = /\{\{connection:(?<name>[a-z_]+)\}\}/gu;
const BODY_SNIPPET_CHARS = 300;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ITEMS_PER_DRAIN = 25;
const DEFAULT_MAX_ITEMS_PER_ACTOR = 10;
export const DEFAULT_WRITE_TIMEOUT_MS = 60_000;

interface ApprovedRow {
  item_id: string;
  connection_id: string;
  actor_id: string;
  verb: string;
  target: string;
  request_json: string;
  decided_at: string | null;
}

function drainApprovedRowsInOrder(
  rows: readonly ApprovedRow[],
  drain: (row: ApprovedRow) => void | PromiseLike<void>
): Promise<void> {
  return rows.reduce<Promise<void>>(
    (sequence, row) => sequence.then(() => drain(row)),
    Promise.resolve()
  );
}

export interface OutboxExecutorOptions {
  staleAfterMs?: number;
  maxItemsPerDrain?: number;
  maxItemsPerActor?: number;
  writeTimeoutMs?: number;
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
  deferred: number;
  reparked: number;
}

export class OutboxExecutor {
  private readonly draining = new Map<string, Promise<DrainReport>>();
  private readonly staleAfterMs: number;
  private readonly maxItemsPerDrain: number;
  private readonly maxItemsPerActor: number;
  private readonly writeTimeoutMs: number;

  constructor(
    private readonly broker: ConnectionBroker,
    private readonly logger: RuntimeLogger,
    private readonly fetchImpl: typeof fetch = fetch,
    options: OutboxExecutorOptions = {}
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxItemsPerDrain =
      options.maxItemsPerDrain ?? DEFAULT_MAX_ITEMS_PER_DRAIN;
    this.maxItemsPerActor =
      options.maxItemsPerActor ?? DEFAULT_MAX_ITEMS_PER_ACTOR;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  }

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
        `SELECT item_id, connection_id, actor_id, verb, target, request_json, decided_at
           FROM outbox_item WHERE status = 'approved' ORDER BY staged_at`
      )
      .all() as unknown as ApprovedRow[];
    const report: DrainReport = {
      approved: rows.length,
      sent: 0,
      failed: 0,
      deferred: 0,
      reparked: 0,
    };
    const now = Date.now();
    const perActor = new Map<string, number>();
    let drained = 0;
    await drainApprovedRowsInOrder(rows, async (row) => {
      const decidedAtMs = row.decided_at
        ? Date.parse(row.decided_at)
        : Number.NaN;
      if (
        Number.isFinite(decidedAtMs) &&
        now - decidedAtMs > this.staleAfterMs
      ) {
        await this.repark(
          plane,
          row.item_id,
          `approval expired undrained after ${Math.round(this.staleAfterMs / 3_600_000)}h — approve again to send`
        );
        report.reparked += 1;
        return;
      }
      const actorCount = perActor.get(row.actor_id) ?? 0;
      if (
        drained >= this.maxItemsPerDrain ||
        actorCount >= this.maxItemsPerActor
      ) {
        report.deferred += 1;
        return;
      }
      drained += 1;
      perActor.set(row.actor_id, actorCount + 1);
      try {
        const outcome = await this.drainItem(plane, row);
        report[outcome] += 1;
      } catch (error) {
        report.deferred += 1;
        this.logger.warn(
          `outbox: drain of ${row.item_id} (${row.verb}) errored, deferring: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
    if (report.approved > 0) {
      this.logger.info(
        `outbox: drained vault ${plane.boot.vaultId} — sent=${report.sent} failed=${report.failed} ` +
          `deferred=${report.deferred} reparked=${report.reparked}`
      );
    }
    return report;
  }

  private async repark(
    plane: VaultPlane,
    itemId: string,
    note: string
  ): Promise<void> {
    const outcome = await plane.invoke(plane.ownerCredential, {
      command: "outbox.repark",
      input: { item_id: itemId, note },
    });
    if (outcome.status !== "executed") {
      this.logger.warn(
        `outbox: stale item ${itemId} did not repark (${outcome.status}: ${"reason" in outcome ? outcome.reason : "unknown"})`
      );
      return;
    }
    this.writeOutcomeNotice(plane, itemId, "reparked", note);
  }

  private async drainItem(
    plane: VaultPlane,
    row: ApprovedRow
  ): Promise<"sent" | "failed" | "deferred"> {
    const auth = await this.broker.resolveForDrain(plane, row.connection_id);
    if ("refused" in auth) {
      this.logger.warn(`outbox: ${row.item_id} deferred — ${auth.refused}`);
      return "deferred";
    }
    let spec: StagedRequest;
    let injectedSpec: StagedRequest;
    try {
      spec = parseRequest(row.request_json);
      injectedSpec = substitute(spec, auth.values);
      assertDrainable(injectedSpec.url, auth);
    } catch (error) {
      await this.recordResult(
        plane,
        row.item_id,
        "failed",
        undefined,
        errText(error, auth)
      );
      return "failed";
    }
    let refreshed = false;
    const send = async (): Promise<"sent" | "failed" | "deferred"> => {
      let response: { status: number; text: string };
      try {
        response = await this.fetchOnce(injectedSpec, auth);
      } catch (error) {
        this.logger.warn(
          `outbox: ${row.item_id} network failure, deferring: ${errText(error, auth)}`
        );
        return "deferred";
      }
      if (response.status === 401 && auth.refresh && !refreshed) {
        refreshed = true;
        try {
          injectedSpec = substitute(spec, await auth.refresh());
          assertDrainable(injectedSpec.url, auth);
          return send();
        } catch (error) {
          this.logger.warn(
            `outbox: ${row.item_id} token refresh refused: ${errText(error, auth)}`
          );
          return "deferred";
        }
      }
      if (
        response.status === 401 ||
        (response.status === 403 &&
          /insufficient.{0,4}(?:scope|permission)|invalid_scope/iu.test(
            response.text
          ))
      ) {
        await auth
          .onAuthDead?.(
            `outbox drain rejected (${response.status}) — reconnect to authorize external writes`
          )
          .catch(() => undefined);
        return "deferred";
      }
      if (response.status === 429 || response.status >= 500) {
        this.logger.warn(
          `outbox: ${row.item_id} upstream ${response.status}, deferring to next drain`
        );
        return "deferred";
      }
      const disposition = response.status < 300 ? "sent" : "failed";
      await this.recordResult(
        plane,
        row.item_id,
        disposition,
        response.status,
        disposition === "failed"
          ? scrub(response.text.slice(0, BODY_SNIPPET_CHARS), auth)
          : undefined
      );
      return disposition;
    };
    return send();
  }

  private async fetchOnce(
    spec: StagedRequest,
    auth: ConnectionAuth
  ): Promise<{ status: number; text: string }> {
    const run = async (): Promise<{ status: number; text: string }> => {
      const response = await this.fetchImpl(spec.url, {
        method: spec.method,
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        redirect: "manual",
        signal: timeoutSignal(this.writeTimeoutMs),
      });
      return { status: response.status, text: await response.text() };
    };
    return auth.limit ? auth.limit(run) : run();
  }

  private async recordResult(
    plane: VaultPlane,
    itemId: string,
    disposition: "sent" | "failed",
    statusCode?: number,
    detail?: string
  ): Promise<void> {
    const outcome = await plane.invoke(plane.ownerCredential, {
      command: "outbox.record_result",
      input: {
        item_id: itemId,
        disposition,
        ...(statusCode === undefined ? {} : { status_code: statusCode }),
        ...(detail === undefined ? {} : { detail }),
      },
    });
    if (outcome.status !== "executed") {
      this.logger.warn(
        `outbox: result for ${itemId} did not record (${outcome.status}: ${"reason" in outcome ? outcome.reason : "unknown"})`
      );
      return;
    }
    this.writeOutcomeNotice(plane, itemId, disposition, detail);
  }

  private writeOutcomeNotice(
    plane: VaultPlane,
    itemId: string,
    disposition: "sent" | "failed" | "reparked",
    detail?: string
  ): void {
    const item = plane
      .listOutbox()
      .find((candidate) => candidate.itemId === itemId);
    const artifact =
      item?.artifact ?? plane.rawOutboxItem(itemId)?.artifact ?? {};
    const artifactLabel = ["title", "subject", "name", "text"]
      .map((key) => artifact[key])
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim() !== ""
      );
    const target = artifactLabel?.trim() ?? item?.target ?? "External write";
    const gist = disposition === "sent" ? undefined : noticeGist(detail);
    const suffix =
      disposition === "sent"
        ? "sent"
        : disposition === "failed"
          ? gist
            ? `failed: ${gist}`
            : "failed"
          : gist
            ? `needs approval again: ${gist}`
            : "needs approval again";
    plane.notices.put({
      kind: "outbox",
      sourceRef: itemId,
      headline: `${target} — ${suffix}`,
      severity:
        disposition === "sent"
          ? "info"
          : disposition === "failed"
            ? "high"
            : "warning",
      detail: {
        sourceType:
          item?.actorKind === "app"
            ? "app"
            : item?.actorKind === "agent" ||
                item?.actorKind === "assistant" ||
                item?.actorKind === "ai_agent"
              ? "agent"
              : "app",
        outcome: disposition,
        itemId,
        ...(item
          ? {
              actor: item.actor,
              actorKind: item.actorKind,
              verb: item.verb,
              target: item.target,
            }
          : {}),
        ...(detail ? { detail } : {}),
        deepLink: "/notifications",
      },
    });
  }
}

function parseRequest(json: string): StagedRequest {
  const parsed = JSON.parse(json) as Partial<StagedRequest>;
  if (typeof parsed.method !== "string" || typeof parsed.url !== "string") {
    throw new Error("outbox request row is missing method/url");
  }
  return parsed as StagedRequest;
}

function substitute(
  spec: StagedRequest,
  values: Readonly<Record<string, string>>
): StagedRequest {
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
    ...(spec.body === undefined ? {} : { body: sub(spec.body) }),
  };
}

function assertDrainable(rawUrl: string, auth: ConnectionAuth): void {
  const url = new URL(rawUrl);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `outbox drain refuses non-https destination ${url.hostname}`
    );
  }
  const allowed = auth.allowedHosts.some((entry) =>
    entry.startsWith("*.")
      ? url.hostname.endsWith(entry.slice(1)) &&
        url.hostname.length > entry.length - 1
      : url.hostname === entry
  );
  if (!allowed) {
    throw new Error(
      `host "${url.hostname}" is outside this connection's allowed_hosts — the credential is pinned to ${auth.allowedHosts.join(", ")}`
    );
  }
}

function scrub(text: string, auth: ConnectionAuth): string {
  let out = text;
  for (const value of Object.values(auth.values)) {
    if (value) out = out.replaceAll(value, "«secret»");
  }
  return out;
}

function errText(err: unknown, auth: ConnectionAuth): string {
  return scrub(err instanceof Error ? err.message : String(err), auth);
}
