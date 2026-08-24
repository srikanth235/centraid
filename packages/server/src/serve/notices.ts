/*
 * Durable notices behind the Notifications surface (#647).
 *
 * This store intentionally owns only notices. Owner decisions remain in
 * their canonical tables and are projected beside these rows by VaultPlane.
 * A `(kind, sourceRef)` pair is one card: repeated outcomes update that card
 * server-side, increment its count, and make it unread/active again.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type NoticeSeverity = "info" | "warning" | "high";
export type AutomationNotifyPolicy = "always" | "failures" | "never";

export interface Notice {
  noticeId: string;
  kind: string;
  sourceRef: string;
  headline: string;
  detail: Record<string, unknown>;
  severity: NoticeSeverity;
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface PutNotice {
  kind: string;
  sourceRef: string;
  headline: string;
  detail?: Record<string, unknown>;
  severity?: NoticeSeverity;
  at?: string;
}

interface NoticeRow {
  notice_id: string;
  kind: string;
  source_ref: string;
  headline: string;
  detail_json: string;
  severity: NoticeSeverity;
  count: number;
  first_at: string;
  last_at: string;
  read_at: string | null;
  archived_at: string | null;
}

const MAX_NOTICES = 1_000;
const DEFAULT_LIST_LIMIT = 200;
const ARCHIVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function fromRow(row: NoticeRow): Notice {
  return {
    noticeId: row.notice_id,
    kind: row.kind,
    sourceRef: row.source_ref,
    headline: row.headline,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    severity: row.severity,
    count: row.count,
    firstAt: row.first_at,
    lastAt: row.last_at,
    readAt: row.read_at,
    archivedAt: row.archived_at,
  };
}

/**
 * The artifact-level gist a headline carries (#647): the first line of a
 * failure message, whitespace-collapsed and bounded. `detail_json` keeps the
 * full record — the headline only has to say WHICH failure this is.
 */
export function noticeGist(
  message: string | undefined,
  maxLength = 80
): string | undefined {
  const firstLine = (message ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!firstLine) return undefined;
  const collapsed = firstLine
    .replace(/\s+/gu, " ")
    // A serialized `Error: …` prefix is noise in a headline, never the gist.
    .replace(/^[A-Za-z]*Error:\s*/u, "")
    .replace(/[.:;,]+$/u, "");
  if (collapsed === "") return undefined;
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}

/**
 * A human label for an automation whose manifest could not be read. Headlines
 * never speak in refs (#647), so `myapp/nightly-digest` reads as
 * "Nightly digest" rather than leaking the on-disk handle.
 */
export function humanizeAutomationRef(ref: string): string {
  const segment = ref.split("/").at(-1) ?? ref;
  const words = segment.replace(/[-_]+/gu, " ").trim();
  if (words === "") return ref;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The card an ENRICHMENT-TIER REFUSAL raises (decision S9).
 *
 * The gate is enforced on the execution path over the `off | device |
 * gateway` axis (#712). The card only appears under `off` or
 * `device` — the tier that stops a gateway-lane (model-turn) enricher —
 * since a `gateway`-tier vault only refuses the automations it hasn't
 * enabled, which is not a policy refusal. As an ordinary skip the refusal is
 * silent (#647), so an owner who asked for faces would get nothing and no
 * explanation. It is a skip, so it is not a failure and never wakes a
 * device (`severity` is deliberately below `high`, which is the only level
 * `NoticeStore.put` wakes on) — but it IS a standing state the owner is
 * owed an account of, with the control that changes it named.
 *
 * Keyed by DOMAIN, not by automation: seven enrichers refusing for the same
 * reason is one fact about the owner's photographs, not seven cards.
 */
export function enrichRefusalNotice(input: {
  domain: string;
  tier?: string;
}): PutNotice {
  const subject =
    input.domain === "photos"
      ? "Photo enrichment"
      : input.domain === "docs"
        ? "Document enrichment"
        : `Enrichment for ${input.domain}`;
  // Each headline states the tier in force AND what it costs, because "off"
  // and "on your devices" are both legitimate settings an owner may have
  // chosen on purpose — the card explains, it does not nag.
  const headline =
    input.tier === "off"
      ? `${subject} is switched off`
      : input.tier === "device"
        ? `${subject} is limited to your devices — captions and recognition aren’t running`
        : input.tier === undefined
          ? `${subject} can’t run — its setting couldn’t be read`
          : `${subject} was refused by its setting (${input.tier})`;
  return {
    detail: {
      deepLink: "/automations",
      enrichDomain: input.domain,
      sourceType: "app",
      ...(input.tier === undefined ? {} : { tier: input.tier }),
    },
    headline,
    kind: "enrichment",
    // An unreadable setting is a fault the owner has to act on; a tier the
    // owner chose is information, not a warning about their own decision.
    severity: input.tier === undefined ? "warning" : "info",
    sourceRef: input.domain,
  };
}

/**
 * Whether a refusal card should be (re)written. A refusal recurs on every
 * enrichment tick for as long as the tier stands, and `NoticeStore.put` clears
 * `read_at` on every write — so re-putting an unchanged refusal would make a
 * card the owner has already read pop back up forever. The card is written
 * once per (domain, tier) and then left alone until the tier moves.
 */
export function shouldWriteEnrichRefusalNotice(
  prior: Notice | undefined,
  tier: string | undefined
): boolean {
  if (!prior) return true;
  const priorTier =
    typeof prior.detail.tier === "string" ? prior.detail.tier : undefined;
  return priorTier !== tier;
}

export function shouldWriteAutomationNotice(
  policy: AutomationNotifyPolicy | undefined,
  outcome: "success" | "failure",
  previousOutcome?: "success" | "failure"
): boolean {
  const resolved = policy ?? "failures";
  if (resolved === "never") return false;
  if (resolved === "always") return true;
  return outcome === "failure" || previousOutcome === "failure";
}

export class NoticeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onChanged: (change: {
      wake: boolean;
      notice: Notice;
    }) => void = () => undefined
  ) {
    // Enforce retention on mount even when the vault receives no new notices.
    this.prune(new Date().toISOString());
  }

  list(input: { includeArchived?: boolean; limit?: number } = {}): Notice[] {
    const limit = Math.max(
      1,
      Math.min(input.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT)
    );
    const rows = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM notifications_notice
          ${input.includeArchived ? "" : "WHERE archived_at IS NULL"}
          ORDER BY archived_at IS NOT NULL, last_at DESC
          LIMIT ?`
      )
      .all(limit) as unknown as NoticeRow[];
    return rows.map(fromRow);
  }

  getBySource(kind: string, sourceRef: string): Notice | undefined {
    const row = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM notifications_notice WHERE kind = ? AND source_ref = ?`
      )
      .get(kind, sourceRef) as unknown as NoticeRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  put(input: PutNotice): Notice {
    const at = input.at ?? new Date().toISOString();
    const noticeId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notifications_notice(
           notice_id, kind, source_ref, headline, detail_json, severity,
           count, first_at, last_at, read_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(kind, source_ref) DO UPDATE SET
           headline = excluded.headline,
           detail_json = excluded.detail_json,
           severity = excluded.severity,
           count = notifications_notice.count + 1,
           last_at = excluded.last_at,
           read_at = NULL,
           archived_at = NULL`
      )
      .run(
        noticeId,
        input.kind,
        input.sourceRef,
        input.headline,
        JSON.stringify(input.detail ?? {}),
        input.severity ?? "info",
        at,
        at
      );
    this.prune(at);
    const written = this.getBySource(input.kind, input.sourceRef);
    if (!written) throw new Error("Notice write did not settle");
    this.onChanged({ wake: written.severity === "high", notice: written });
    return written;
  }

  markRead(
    noticeId: string,
    at = new Date().toISOString()
  ): Notice | undefined {
    const changed = this.db
      .prepare(
        `UPDATE notifications_notice
            SET read_at = COALESCE(read_at, ?)
          WHERE notice_id = ?`
      )
      .run(at, noticeId).changes;
    if (changed === 0) return undefined;
    const notice = this.getById(noticeId);
    if (notice) this.onChanged({ wake: false, notice });
    return notice;
  }

  archive(noticeId: string, at = new Date().toISOString()): Notice | undefined {
    const changed = this.db
      .prepare(
        `UPDATE notifications_notice
            SET read_at = COALESCE(read_at, ?), archived_at = COALESCE(archived_at, ?)
          WHERE notice_id = ?`
      )
      .run(at, at, noticeId).changes;
    if (changed === 0) return undefined;
    const notice = this.getById(noticeId);
    if (notice) this.onChanged({ wake: false, notice });
    return notice;
  }

  private getById(noticeId: string): Notice | undefined {
    const row = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM notifications_notice WHERE notice_id = ?`
      )
      .get(noticeId) as unknown as NoticeRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  private prune(now: string): void {
    const cutoff = new Date(
      Date.parse(now) - ARCHIVED_RETENTION_MS
    ).toISOString();
    this.db
      .prepare(
        `DELETE FROM notifications_notice
          WHERE archived_at IS NOT NULL AND archived_at < ?`
      )
      .run(cutoff);
    this.db
      .prepare(
        `DELETE FROM notifications_notice
          WHERE notice_id IN (
            SELECT notice_id FROM notifications_notice
             ORDER BY archived_at IS NOT NULL, last_at DESC
             LIMIT -1 OFFSET ?
          )`
      )
      .run(MAX_NOTICES);
  }
}
