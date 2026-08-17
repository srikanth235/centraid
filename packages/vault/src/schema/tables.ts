// Logical ↔ physical name registry. The ontology speaks schema-qualified
// logical names (`core.party`) — grants, receipts, links and polymorphic refs
// all store them. SQLite has no namespaces, so physical tables are
// underscore-joined (`core_party`). The gateway translates through this
// registry only, which doubles as an allow-list: unknown entity names never
// reach SQL.
//
// The registry has a static half (the canonical ontology below) and a
// dynamic half (issue #286 phase 2): app-declared ext-band tables recorded
// in `consent_app_ext`. Callers that pass their vault handle resolve both;
// without a handle only the canonical model resolves.

import type { DatabaseSync } from "node:sqlite";

import { parseExtLogical } from "./ext.js";

export const VAULT_TABLES: Readonly<Record<string, readonly string[]>> = {
  core: [
    "vault",
    "party",
    "party_identifier",
    "place",
    "event",
    "account",
    "transaction",
    "content_item",
    "content_derivative",
    "document",
    "attachment",
    "activity",
    "observation",
    "observation_component",
    "link",
    "link_anchor",
    "concept_scheme",
    "concept",
    "tag",
    "collection",
    "collection_entry",
    // P5 pre-mutation snapshots. Grants row-filter this by entity_type.
    "entity_revision",
    // Share-by-placement provenance (issue #599). Registered so a merged
    // multi-scope app view can read the audience + who-placed-it badge for a
    // projected row like any other table.
    "share_origin",
  ],
  consent: [
    "app",
    "agent",
    "app_ext",
    "app_view",
    "access_grant",
    "grant_scope",
    "scope_tombstone",
    "scope_request",
    "policy",
    "device",
    "export_job",
    "seed_row",
  ],
  agent: ["command", "capability", "correction", "judgment"],
  health: [
    "vital",
    "workout",
    "sleep_session",
    "medication_course",
    "condition",
  ],
  finance: ["txn_split", "budget", "holding", "recurring_series", "fx_rate"],
  schedule: [
    "calendar",
    "event_ext",
    "attendee",
    "task",
    "project",
    "section",
    "recurrence_exception",
    "availability_rule",
  ],
  social: [
    "contact_card",
    "contact_channel",
    "circle",
    "circle_member",
    "thread",
    "thread_participant",
    "message",
  ],
  knowledge: ["note", "annotation"],
  media: [
    "asset",
    "face_region",
    "asset_phash",
    // Memories v0 (issue #724 W7): a rebuildable projection over signals the
    // vault already carries — see schema/enrich.ts's header for the shape and
    // enrich/memories.ts for the sweep that (re)derives it. Registered here
    // (not a new column on media_asset) for the same reason
    // media_asset_phash is a sidecar: this is app-reachable derived data, and
    // registering it under the existing `{schema:'media', verbs:'read'}`
    // grant scope (packages/blueprints/apps/photos/app.json) means no app
    // manifest or mobile consent change is needed to read it.
    "memory",
    "memory_member",
    // Faces (issue #724 W5): the unnamed-face grouping projection — see
    // schema/enrich.ts's header for why identity is NOT in it. Registered for
    // the same two reasons `memory` is: it is app-reachable derived data, so
    // the existing `{schema:'media', verbs:'read'}` grant scope covers it with
    // no manifest change, and registration is what installs the replica
    // change-log triggers, so a rebuild (or a person-forget cascade) reaches an
    // offline phone like any other row change.
    "face_cluster",
  ],
  home: [
    "asset_item",
    "warranty",
    "maintenance_plan",
    "utility_meter",
    "meter_reading",
  ],
  business: ["client", "project", "time_entry", "invoice", "invoice_line"],
  people: ["profile", "important_date"],
  locker: ["item"],
  sync: [
    "connection",
    "external_entity",
    "import_batch",
    "import_row",
    "connection_cursor",
    "connection_run",
    "connection_credential",
    "connection_health",
  ],
  tally: [
    "friend",
    "group",
    "expense",
    "expense_split",
    "expense_receipt",
    "expense_line_item",
    "expense_line_allocation",
    "recurring_expense",
    "settlement",
    "obligation",
  ],
  // `derivation` (issue #724 W2's provenance stamp) is registered here for the
  // reason `portable-export.ts`'s own audit note already assumes it is: the
  // canonical table walk IS this list, so an unregistered table is silently
  // absent from every export AND gets no replica change-log trigger. Both
  // matter for the face-delete gate (#724 W5): a stamp left behind after
  // `media.forget_person` would survive a restore and would never reach an
  // offline phone, and it is the row that tells the next sweep those faces
  // are current.
  // `policy_rule` and `consent` (issue #807) are registered for the same two
  // reasons: both are OWNER DECISIONS, so a portable restore that dropped them
  // would hand back a vault that had forgotten which scopes enrich with what
  // and which egress the owner ever agreed to — the second silently re-asking
  // for consent already given, or losing a recorded refusal. Registration also
  // installs the replica change-log triggers, which is what lets a phone show
  // the effective policy it is governed by.
  enrich: [
    "embedding",
    "request",
    "policy",
    "derivation",
    "policy_rule",
    "consent",
  ],
  outbox: ["item", "grant"],
  // Commons control truth and local mechanics (#731). These must stay in the
  // canonical walk: a portable restore without the grant/roster bindings,
  // ordered op log, cursors, intent overlay, or pending invitations would
  // silently turn shared content into an unrelated local copy.
  share: [
    "party_vault_binding",
    "circle_grant",
    "commons_member_state",
    "commons_op",
    "commons_replay",
    "commons_receipt",
    "commons_cursor",
    "commons_lineage",
    "commons_retained",
    "commons_intent",
    "commons_invitation",
  ],
  notifications: ["notice"],
  // Read-only custody projections, both rebuilt on the standing sweep:
  // `custody_state` (issue #352) is local-vs-replicated state per content item;
  // `custody_rollup` (issue #711) is its aggregate — per-bucket counts and
  // bytes, including how much of the local tier is provably safe to release.
  // See blob/custody.ts and blob/custody-rollup.ts.
  blob: ["custody_state", "custody_rollup"],
};

/** journal.db tables — the append-only audit stream. */
export const JOURNAL_TABLES: Readonly<Record<string, readonly string[]>> = {
  consent: ["provenance", "receipt"],
  agent: ["command_invocation", "invocation_check", "evidence", "explanation"],
};

export interface EntityRef {
  schema: string;
  table: string;
  /** Physical SQLite table name, e.g. `core_party`. */
  physical: string;
  /** Which file holds it. */
  file: "vault" | "journal";
}

/**
 * Resolve a logical `schema.table` name. Returns undefined for anything not
 * in the registry — callers treat that as a denial, never as SQL.
 *
 * Ext-band names (`ext.<appId>.<table>`, draft twin `extdraft.…`) resolve
 * only when the caller passes its vault handle — the dynamic half lives in
 * `consent_app_ext`. Both bands report the consent schema `ext.<appId>`:
 * the draft copy is the same data class under the same grant.
 */
export function resolveEntity(
  logical: string,
  vault?: DatabaseSync
): EntityRef | undefined {
  const dot = logical.indexOf(".");
  if (dot <= 0) return undefined;
  const schema = logical.slice(0, dot);
  const table = logical.slice(dot + 1);
  if (VAULT_TABLES[schema]?.includes(table)) {
    return { schema, table, physical: `${schema}_${table}`, file: "vault" };
  }
  if (JOURNAL_TABLES[schema]?.includes(table)) {
    return { schema, table, physical: `${schema}_${table}`, file: "journal" };
  }
  const ext = parseExtLogical(logical);
  if (ext && vault) {
    try {
      const row = vault
        .prepare(
          `SELECT physical FROM consent_app_ext WHERE app_id = ? AND band = ? AND table_name = ?`
        )
        .get(ext.appId, ext.band, ext.table) as
        | { physical: string }
        | undefined;
      if (row) {
        return {
          schema: `ext.${ext.appId}`,
          table: ext.table,
          physical: row.physical,
          file: "vault",
        };
      }
    } catch {
      // Pre-v5 file or a non-vault handle: no dynamic half to consult.
    }
  }
  return undefined;
}

/**
 * All logical vault-file entity names, `schema.table`. With a handle, the
 * live ext band is enumerated too (retained tables included — export covers
 * everything); the draft band is scratch and never enumerated.
 */
export function listVaultEntities(vault?: DatabaseSync): string[] {
  const canonical = Object.entries(VAULT_TABLES).flatMap(([schema, tables]) =>
    tables.map((t) => `${schema}.${t}`)
  );
  if (!vault) return canonical;
  try {
    const rows = vault
      .prepare(
        `SELECT app_id, table_name FROM consent_app_ext WHERE band = 'live' ORDER BY app_id, table_name`
      )
      .all() as { app_id: string; table_name: string }[];
    return [
      ...canonical,
      ...rows.map((r) => `ext.${r.app_id}.${r.table_name}`),
    ];
  } catch {
    return canonical;
  }
}
