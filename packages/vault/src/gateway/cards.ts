// Card resolver (#272): turns (type, id) refs into minimal renderable cards so apps DISPLAY
// foreign entities without read scope on them; resolvable-if-linked — a LIVE link touching the
// ref authorizes rendering the far end, else per-ref denied; the batch is receipted either way.

import type { DatabaseSync } from "node:sqlite";

import { resolveEntity } from "../schema/tables.js";
import { evaluateAccess } from "./access.js";
import { skipsAllowReceipt, writeReceipt } from "./evidence.js";
import type { Identity } from "./types.js";

export interface RefRequest {
  refs: { type: string; id: string }[];
}

export interface RefCard {
  type: string;
  id: string;
  /** `missing` is a tombstone, `denied` a consent gap, `unknown` a bad type. */
  status: "live" | "trashed" | "missing" | "denied" | "unknown";
  title: string | null;
  subtitle: string | null;
  /** A core.content_item id renderable as a thumbnail, if any. */
  thumbnail_content_id: string | null;
}

export interface ResolveResult {
  cards: RefCard[];
  /** Absent on an owner-direct resolve — see `ReadResult.receiptId`. */
  receiptId?: string;
}

/** Refs render in lists, not bulk exports. */
const MAX_REFS = 100;

/** One SELECT per carded entity; uncurated resolve existence + status only. */
const CARD_SQL: Record<string, string> = {
  "core.party": `SELECT display_name AS title, kind AS subtitle, avatar_content_id AS thumb, 0 AS trashed
                   FROM core_party WHERE party_id = ?`,
  "core.place": `SELECT name AS title, kind AS subtitle, NULL AS thumb, 0 AS trashed
                   FROM core_place WHERE place_id = ?`,
  "core.event": `SELECT summary AS title, dtstart AS subtitle, NULL AS thumb, 0 AS trashed
                   FROM core_event WHERE event_id = ?`,
  "core.transaction": `SELECT description AS title,
                              printf('%s %.2f', currency, amount_minor / 100.0) AS subtitle,
                              NULL AS thumb, 0 AS trashed
                         FROM core_transaction WHERE txn_id = ?`,
  "core.content_item": `SELECT coalesce(title, media_type) AS title, media_type AS subtitle,
                               CASE WHEN media_type LIKE 'image/%' THEN content_id END AS thumb,
                               (deleted_at IS NOT NULL) AS trashed
                          FROM core_content_item WHERE content_id = ?`,
  "core.document": `SELECT d.title AS title, c.media_type AS subtitle,
                            CASE WHEN c.media_type LIKE 'image/%' THEN c.content_id END AS thumb,
                            (d.deleted_at IS NOT NULL) AS trashed
                       FROM core_document d JOIN core_content_item c ON c.content_id = d.current_content_id
                      WHERE d.document_id = ?`,
  "schedule.task": `SELECT title, status AS subtitle, NULL AS thumb, 0 AS trashed
                      FROM schedule_task WHERE task_id = ?`,
  "knowledge.note": `SELECT title, NULL AS subtitle, NULL AS thumb, 0 AS trashed
                       FROM knowledge_note WHERE note_id = ?`,
  "core.collection": `SELECT name AS title, NULL AS subtitle, cover_content_id AS thumb, 0 AS trashed
                        FROM core_collection WHERE collection_id = ?`,
  "social.thread": `SELECT coalesce(subject, channel) AS title, channel AS subtitle,
                           NULL AS thumb, 0 AS trashed
                      FROM social_thread WHERE thread_id = ?`,
  "media.asset": `SELECT coalesce(ci.title, a.kind) AS title,
                               coalesce(a.captured_at, ci.created_at) AS subtitle,
                               a.content_id AS thumb, (a.deleted_at IS NOT NULL) AS trashed
                          FROM media_asset a
                          JOIN core_content_item ci ON ci.content_id = a.content_id
                         WHERE a.asset_id = ?`,
};

/** Entity types with a curated card: the picker's default kinds. */
export const CARDED_ENTITIES: readonly string[] = Object.keys(CARD_SQL);

/** PKs are UUIDv7, so `ORDER BY pk DESC` IS recent-first (#262). */
export const CARD_PK: Readonly<Record<string, string>> = {
  "core.party": "party_id",
  "core.place": "place_id",
  "core.event": "event_id",
  "core.transaction": "txn_id",
  "core.content_item": "content_id",
  "core.document": "document_id",
  "schedule.task": "task_id",
  "knowledge.note": "note_id",
  "core.collection": "collection_id",
  "social.thread": "thread_id",
  "media.asset": "asset_id",
};

function pkColumn(vault: DatabaseSync, physical: string): string {
  const rows = vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? "rowid";
}

/** A LIVE link touches this ref AND the caller reads the far endpoint.
 * Entity-level: the far-row filter is not re-evaluated per row. */
function linkedAndVisible(
  vault: DatabaseSync,
  identity: Identity,
  type: string,
  id: string
): boolean {
  const others = vault
    .prepare(
      `SELECT DISTINCT from_type AS t FROM core_link
        WHERE to_type = ? AND to_id = ? AND valid_to IS NULL
       UNION
       SELECT DISTINCT to_type AS t FROM core_link
        WHERE from_type = ? AND from_id = ? AND valid_to IS NULL`
    )
    .all(type, id, type, id) as { t: string }[];
  for (const other of others) {
    const ref = resolveEntity(other.t, vault);
    if (!ref) continue;
    const access = evaluateAccess(
      vault,
      identity,
      ref.schema,
      ref.table,
      "read"
    );
    if (access.decision === "allow") return true;
  }
  return false;
}

function cardFor(vault: DatabaseSync, type: string, id: string): RefCard {
  const ref = resolveEntity(type, vault);
  if (!ref) {
    return {
      type,
      id,
      status: "unknown",
      title: null,
      subtitle: null,
      thumbnail_content_id: null,
    };
  }
  const sql = CARD_SQL[type];
  if (sql) {
    const row = vault.prepare(sql).get(id) as
      | {
          title: string | null;
          subtitle: string | null;
          thumb: string | null;
          trashed: number;
        }
      | undefined;
    if (!row) {
      return {
        type,
        id,
        status: "missing",
        title: null,
        subtitle: null,
        thumbnail_content_id: null,
      };
    }
    return {
      type,
      id,
      status: row.trashed ? "trashed" : "live",
      title: row.title ?? null,
      subtitle: row.subtitle == null ? null : String(row.subtitle),
      thumbnail_content_id: row.thumb ?? null,
    };
  }
  // Uncurated entity: existence + status only.
  const pk = pkColumn(vault, ref.physical);
  const live = vault
    .prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`)
    .get(id);
  return {
    type,
    id,
    status: live ? "live" : "missing",
    title: null,
    subtitle: null,
    thumbnail_content_id: null,
  };
}

/** One receipt per batch; a bad ref is denied, never thrown. */
export function resolveRefCards(
  vault: DatabaseSync,
  journal: DatabaseSync,
  identity: Identity,
  request: RefRequest
): ResolveResult {
  const refs = (request.refs ?? []).slice(0, MAX_REFS);
  const cards: RefCard[] = [];
  for (const { type, id } of refs) {
    if (typeof type !== "string" || typeof id !== "string" || !type || !id) {
      cards.push({
        type: String(type ?? ""),
        id: String(id ?? ""),
        status: "unknown",
        title: null,
        subtitle: null,
        thumbnail_content_id: null,
      });
      continue;
    }
    const ref = resolveEntity(type, vault);
    if (!ref) {
      cards.push({
        type,
        id,
        status: "unknown",
        title: null,
        subtitle: null,
        thumbnail_content_id: null,
      });
      continue;
    }
    const direct = evaluateAccess(
      vault,
      identity,
      ref.schema,
      ref.table,
      "read"
    );
    const allowed =
      direct.decision === "allow" ||
      linkedAndVisible(vault, identity, type, id);
    if (!allowed) {
      cards.push({
        type,
        id,
        status: "denied",
        title: null,
        subtitle: null,
        thumbnail_content_id: null,
      });
      continue;
    }
    cards.push(cardFor(vault, type, id));
  }
  const receiptId = skipsAllowReceipt(identity)
    ? undefined
    : writeReceipt(journal, {
        authorityId: null,
        invocationId: null,
        action: "read resolve_refs",
        objectType: "core.link",
        objectId: null,
        decision: "allow",
        detail: {
          refs: refs.map((r) => `${r.type}/${r.id}`),
          denied: cards.filter((c) => c.status === "denied").length,
        },
      });
  return { cards, ...(receiptId === undefined ? {} : { receiptId }) };
}
