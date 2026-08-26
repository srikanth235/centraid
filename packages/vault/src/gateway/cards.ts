// Card resolver (#272): turns (type, id) refs into minimal renderable cards so apps DISPLAY
// foreign entities without read scope on them; resolvable-if-linked — a LIVE link touching the
// ref authorizes rendering the far end, else per-ref denied; the batch is receipted either way.

import type { DatabaseSync } from "node:sqlite";

import { resolveEntity } from "../schema/tables.js";
import { evaluateConsent } from "./consent.js";
import { writeReceipt } from "./evidence.js";
import type { Identity } from "./types.js";

export interface RefRequest {
  refs: { type: string; id: string }[];
  /** Declared DPV purpose, e.g. `dpv:ServiceProvision`. */
  purpose: string;
}

export interface RefCard {
  type: string;
  id: string;
  /** `live` renders; `trashed` soft-deleted; `missing` tombstone; `denied` consent gap; `unknown` type. */
  status: "live" | "trashed" | "missing" | "denied" | "unknown";
  title: string | null;
  subtitle: string | null;
  /** A core.content_item id renderable as a thumbnail, if any. */
  thumbnail_content_id: string | null;
}

export interface ResolveResult {
  cards: RefCard[];
  receiptId: string;
}

/** Hard cap per call — refs render in lists, not bulk exports. */
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
  "home.asset_item": `SELECT name AS title, serial_no AS subtitle, NULL AS thumb, 0 AS trashed
                        FROM home_asset_item WHERE item_id = ?`,
  "business.client": `SELECT p.display_name AS title, c.status AS subtitle, NULL AS thumb, 0 AS trashed
                        FROM business_client c JOIN core_party p ON p.party_id = c.party_id
                       WHERE c.client_id = ?`,
  "business.project": `SELECT name AS title, status AS subtitle, NULL AS thumb, 0 AS trashed
                         FROM business_project WHERE project_id = ?`,
  "business.invoice": `SELECT number AS title, status AS subtitle, NULL AS thumb, 0 AS trashed
                         FROM business_invoice WHERE invoice_id = ?`,
};

/** Entity types with a curated card — the picker's default kind set. */
export const CARDED_ENTITIES: readonly string[] = Object.keys(CARD_SQL);

/** PKs are UUIDv7, so `ORDER BY pk DESC` IS recent-first — picker no-term browse (#262). */
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
  "home.asset_item": "item_id",
  "business.client": "client_id",
  "business.project": "project_id",
  "business.invoice": "invoice_id",
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

/** LIVE link touches this ref AND caller reads the far endpoint. Entity-level in v0 —
 * the far-row filter is not re-evaluated per row; resolutions are receipted. */
function linkedAndVisible(
  vault: DatabaseSync,
  identity: Identity,
  type: string,
  id: string,
  purpose: string
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
    const consent = evaluateConsent(
      vault,
      identity,
      ref.schema,
      ref.table,
      "read",
      purpose
    );
    if (consent.decision === "allow") return true;
  }
  return false;
}

function cardFor(vault: DatabaseSync, type: string, id: string): RefCard {
  const ref = resolveEntity(type, vault);
  if (!ref || ref.file !== "vault") {
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

/** Up to MAX_REFS refs → cards, one receipt per batch; never throws for a bad ref. */
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
    if (!ref || ref.file !== "vault") {
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
    const direct = evaluateConsent(
      vault,
      identity,
      ref.schema,
      ref.table,
      "read",
      request.purpose
    );
    const allowed =
      direct.decision === "allow" ||
      linkedAndVisible(vault, identity, type, id, request.purpose);
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
  const receiptId = writeReceipt(journal, {
    grantId: null,
    invocationId: null,
    action: "read resolve_refs",
    objectType: "core.link",
    objectId: null,
    purpose: request.purpose,
    decision: "allow",
    detail: {
      refs: refs.map((r) => `${r.type}/${r.id}`),
      denied: cards.filter((c) => c.status === "denied").length,
    },
  });
  return { cards, receiptId };
}
