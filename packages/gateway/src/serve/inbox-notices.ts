/*
 * Durable Inbox notices (#647).
 *
 * This store intentionally owns only notices. Owner decisions remain in
 * their canonical tables and are projected beside these rows by VaultPlane.
 * A `(kind, sourceRef)` pair is one card: repeated outcomes update that card
 * server-side, increment its count, and make it unread/active again.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type InboxNoticeSeverity = "info" | "warning" | "high";
export type AutomationNotifyPolicy = "always" | "failures" | "never";

export interface InboxNotice {
  noticeId: string;
  kind: string;
  sourceRef: string;
  headline: string;
  detail: Record<string, unknown>;
  severity: InboxNoticeSeverity;
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface PutInboxNotice {
  kind: string;
  sourceRef: string;
  headline: string;
  detail?: Record<string, unknown>;
  severity?: InboxNoticeSeverity;
  at?: string;
}

interface NoticeRow {
  notice_id: string;
  kind: string;
  source_ref: string;
  headline: string;
  detail_json: string;
  severity: InboxNoticeSeverity;
  count: number;
  first_at: string;
  last_at: string;
  read_at: string | null;
  archived_at: string | null;
}

const MAX_NOTICES = 1_000;
const DEFAULT_LIST_LIMIT = 200;
const ARCHIVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function fromRow(row: NoticeRow): InboxNotice {
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
 * The artifact-level gist a headline carries (#647 D4): the first line of a
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
 * never speak in refs (#647 D4), so `myapp/nightly-digest` reads as
 * "Nightly digest" rather than leaking the on-disk handle.
 */
export function humanizeAutomationRef(ref: string): string {
  const segment = ref.split("/").at(-1) ?? ref;
  const words = segment.replace(/[-_]+/gu, " ").trim();
  if (words === "") return ref;
  return words.charAt(0).toUpperCase() + words.slice(1);
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

export class InboxNoticeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onChanged: (change: {
      wake: boolean;
      notice: InboxNotice;
    }) => void = () => undefined
  ) {
    // Enforce retention on mount even when the vault receives no new notices.
    this.prune(new Date().toISOString());
  }

  list(
    input: { includeArchived?: boolean; limit?: number } = {}
  ): InboxNotice[] {
    const limit = Math.max(
      1,
      Math.min(input.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT)
    );
    const rows = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM inbox_notice
          ${input.includeArchived ? "" : "WHERE archived_at IS NULL"}
          ORDER BY archived_at IS NOT NULL, last_at DESC
          LIMIT ?`
      )
      .all(limit) as unknown as NoticeRow[];
    return rows.map(fromRow);
  }

  getBySource(kind: string, sourceRef: string): InboxNotice | undefined {
    const row = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM inbox_notice WHERE kind = ? AND source_ref = ?`
      )
      .get(kind, sourceRef) as unknown as NoticeRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  put(input: PutInboxNotice): InboxNotice {
    const at = input.at ?? new Date().toISOString();
    const noticeId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO inbox_notice(
           notice_id, kind, source_ref, headline, detail_json, severity,
           count, first_at, last_at, read_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(kind, source_ref) DO UPDATE SET
           headline = excluded.headline,
           detail_json = excluded.detail_json,
           severity = excluded.severity,
           count = inbox_notice.count + 1,
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
    if (!written) throw new Error("Inbox notice write did not settle");
    this.onChanged({ wake: written.severity === "high", notice: written });
    return written;
  }

  markRead(
    noticeId: string,
    at = new Date().toISOString()
  ): InboxNotice | undefined {
    const changed = this.db
      .prepare(
        `UPDATE inbox_notice
            SET read_at = COALESCE(read_at, ?)
          WHERE notice_id = ?`
      )
      .run(at, noticeId).changes;
    if (changed === 0) return undefined;
    const notice = this.getById(noticeId);
    if (notice) this.onChanged({ wake: false, notice });
    return notice;
  }

  archive(
    noticeId: string,
    at = new Date().toISOString()
  ): InboxNotice | undefined {
    const changed = this.db
      .prepare(
        `UPDATE inbox_notice
            SET read_at = COALESCE(read_at, ?), archived_at = COALESCE(archived_at, ?)
          WHERE notice_id = ?`
      )
      .run(at, at, noticeId).changes;
    if (changed === 0) return undefined;
    const notice = this.getById(noticeId);
    if (notice) this.onChanged({ wake: false, notice });
    return notice;
  }

  private getById(noticeId: string): InboxNotice | undefined {
    const row = this.db
      .prepare(
        `SELECT notice_id, kind, source_ref, headline, detail_json, severity,
                count, first_at, last_at, read_at, archived_at
           FROM inbox_notice WHERE notice_id = ?`
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
        `DELETE FROM inbox_notice
          WHERE archived_at IS NOT NULL AND archived_at < ?`
      )
      .run(cutoff);
    this.db
      .prepare(
        `DELETE FROM inbox_notice
          WHERE notice_id IN (
            SELECT notice_id FROM inbox_notice
             ORDER BY archived_at IS NOT NULL, last_at DESC
             LIMIT -1 OFFSET ?
          )`
      )
      .run(MAX_NOTICES);
  }
}
