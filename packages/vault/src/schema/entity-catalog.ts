// Logical ↔ physical name registry. The ontology speaks schema-qualified
// logical names (`core.party`) — grants, receipts, links and polymorphic refs
// all store them. SQLite has no namespaces, so physical tables are
// underscore-joined (`core_party`). The gateway translates through this
// registry only, which doubles as an allow-list: unknown entity names never
// reach SQL.
//
// The registry has a static half (the canonical ontology below) and a
// dynamic half (#286): app-declared ext-band tables recorded
// in `access_app_ext`. Callers that pass their vault handle resolve both;
// without a handle only the canonical model resolves.
//
// SINCE #883 (ruling O-label) EVERY ENTITY CARRIES ITS NAME HERE. The registry
// is the one owner of what an entity is CALLED, not just of the fact that it
// exists: four hand-maintained maps used to name the same tables again — the
// Atlas's curated kinds, the FTS spec list's physical names, the replica's
// local-search surface and Notes' link-target table — and a table added to one
// was named in the others by hand or not at all. A declaration with no label
// fails `assertRegistryLabels`, which the schema build runs (`migrateVault`),
// so the next table cannot arrive nameless and be named again in four places.

import type { EntityRegistry } from "./entity-declaration.js";

export {
  type EntityLifecycle,
  type EntityRegistry,
  type VaultEntityDeclaration,
} from "./entity-declaration.js";

export const VAULT_ENTITIES: EntityRegistry = {
  core: {
    vault: {
      lifecycle: "mutable",
      label: "Vault",
      blurb: "This vault itself — its name and identity.",
    },
    party: {
      // #916, owner decision D1: a person is trashed and then PURGED like
      // every other kind. The per-column audit of the foreign keys onto
      // `core_party` — what decides whether a purge succeeds — is
      // `schema/party-fk-audit.ts`.
      lifecycle: "trash",
      label: "People",
      blurb: "Everyone you know — people and organisations.",
    },
    party_identifier: {
      lifecycle: "mutable",
      label: "Identifiers",
      blurb: "Emails, phones and handles for each person.",
    },
    place: {
      label: "Places",
      blurb: "Locations that matter to you.",
      lifecycle: "mutable",
    },
    event: {
      lifecycle: "trash",
      label: "Events",
      blurb: "Things that happened or will happen.",
    },
    account: {
      lifecycle: "append-only",
      label: "Accounts",
      blurb: "Money accounts — bank, card, wallet.",
    },
    transaction: {
      lifecycle: "mutable",
      label: "Transactions",
      blurb: "Money moving in and out of your accounts.",
    },
    content_item: {
      label: "Content",
      blurb: "Files and media you've saved.",
      lifecycle: "trash",
      // A note body is a `data:` URI in `content_uri`, so this row is where
      // the ontology keeps long member TEXT (#922, SB-text). Past 1 MiB the
      // value has stopped being a body and is a document: it takes the blob
      // path, and both clients name the absence.
      replicaValues: { textCeilingBytes: 1_024 * 1_024 },
    },
    content_derivative: {
      lifecycle: "mutable",
      label: "Derivatives",
      blurb: "Thumbnails and previews made from content.",
      // `text_content` is a document's extracted text or a recording's
      // transcript — what a Docs screen renders offline. Same ceiling as the
      // body it came from; picture variants carry a sha, not bytes.
      replicaValues: { textCeilingBytes: 1_024 * 1_024 },
    },
    document: {
      label: "Documents",
      blurb: "Your documents and their text.",
      lifecycle: "trash",
    },
    attachment: {
      lifecycle: "append-only",
      label: "Attachments",
      blurb: "Files pinned to other things.",
    },
    activity: {
      label: "Activity",
      blurb: "A log of what you've done.",
      lifecycle: "append-only",
    },
    // `observation` and `observation_component` are gone (#916, ruling
    // ONT-06). The measurement spine was reachable only through `health.*`,
    // and it left with them: no writer, no reader, no surface. `activity`
    // stays — People writes an interaction to it.
    link: {
      lifecycle: "mutable",
      label: "Links",
      blurb: "Connections you've drawn between things.",
    },
    link_anchor: {
      lifecycle: "mutable",
      label: "Anchors",
      blurb: "Where a link points inside a document.",
    },
    concept_scheme: {
      lifecycle: "append-only",
      label: "Vocabularies",
      blurb: "Named sets of tags and categories.",
    },
    concept: {
      lifecycle: "mutable",
      label: "Concepts",
      blurb: "The tags and categories themselves.",
    },
    tag: {
      label: "Tags",
      blurb: "Labels you put on things.",
      lifecycle: "mutable",
    },
    collection: {
      lifecycle: "mutable",
      label: "Collections",
      blurb: "Groups of things you've gathered.",
    },
    collection_entry: {
      lifecycle: "append-only",
      label: "Collection items",
      blurb: "What's inside each collection.",
    },
    // P5 pre-mutation snapshots. Grants row-filter this by entity_type.
    entity_revision: {
      lifecycle: "mutable",
      label: "Entity history",
      blurb: "Pre-mutation snapshots for version history and undo.",
    },
    // Share-by-placement provenance (#599). Registered so a merged
    // multi-scope app view can read the audience + who-placed-it badge for a
    // projected row like any other table.
    share_origin: {
      lifecycle: "mutable",
      // Its PRIMARY KEY *is* its pointer, so a provenance row cannot outlive
      // the row it attributes; it names a target, it is not one (#916).
      projectionOf: "core.entity",
      label: "Shared with here",
      blurb: "Where an item placed in this space came from, and who placed it.",
    },
  },
  // `access`, not `consent` (#916, owner decision D4), and REGISTERS ONLY
  // since #928: an install register, an enrolment register, a device
  // register and the demo-seed register. What the plane decides — who may
  // reach what — is a `share_authority` row, one plane for every principal.
  // The plane's evidence stream is the audit band's `access.provenance` and
  // `access.receipt`, BAND-EXCLUDED from this registry — see
  // `schema/audit.ts` and `schema/local-tables.ts`.
  access: {
    app: { label: "Installed apps", lifecycle: "machinery" },
    agent: { label: "Agent registrations", lifecycle: "machinery" },
    app_ext: { label: "App tables", lifecycle: "machinery" },
    device: { label: "Devices", lifecycle: "machinery" },
    seed_row: { label: "Seeded rows", lifecycle: "machinery" },
  },
  agent: {
    command: { label: "Agent commands", lifecycle: "machinery" },
    capability: { label: "Agent capabilities", lifecycle: "machinery" },
  },
  // HOW A LIFECYCLE WAS DECIDED (#916, ruling ONT-08). Not by intent — by
  // evidence, in this order: `trash` if the table carries `deleted_at` +
  // `purge_at`; else `mutable` if it already carries `updated_at`, or if any
  // non-test source under `packages/vault/src` or `packages/server/src` runs
  // `UPDATE <physical>` on it (the grep is re-run as a test, so the answer
  // cannot go stale — see `schema/lifecycle.test.ts`); else `append-only`.
  //
  // Two surprises worth naming, because the drift register guessed otherwise:
  // `core.transaction`, `core.link` and `core.tag` all read as append-only
  // spine and all have a live in-place writer (an import correcting an amount,
  // a link being end-dated, a machine tag's confidence being revised), so they
  // are `mutable`. `core.account` and `schedule.calendar` read as editable and
  // have no writer at all, so they are `append-only` until one arrives — and
  // `atlas.update_row` now refuses them, which is the point: the declaration
  // is the contract, not a description.
  //
  // `health` and `finance` are gone (#916, ruling ONT-06): ten tables with
  // eleven typed commands, no blueprint surface and no import path — the same
  // test O-domains applied to `home`/`business`. `core.account` and
  // `core.transaction` STAY: Tally's settle-up posts into them, so the money
  // spine has a consumer even though the finance EXTENSIONS did not.
  // `access.app_view` (a road no app took), `access.export_job` (a second
  // copy of the receipt an export already writes), `agent.correction` /
  // `agent.judgment` (the learn loop with no caller) and
  // `schedule.availability_rule` left in the same rung, for the same reason.
  schedule: {
    calendar: {
      lifecycle: "append-only",
      label: "Calendars",
      blurb: "Your calendars — work, home, and more.",
    },
    event_ext: {
      lifecycle: "mutable",
      label: "Event details",
      blurb: "Extra scheduling detail on an event.",
    },
    attendee: {
      label: "Guests",
      blurb: "Who's invited to each event.",
      lifecycle: "mutable",
    },
    task: {
      label: "Tasks",
      blurb: "Things to do, with due dates.",
      lifecycle: "trash",
    },
    project: {
      lifecycle: "mutable",
      label: "Task projects",
      blurb: "Ordered projects and areas for tasks.",
    },
    section: {
      lifecycle: "mutable",
      label: "Task sections",
      blurb: "Ordered sections within a task project.",
    },
    recurrence_exception: {
      lifecycle: "mutable",
      label: "Recurrence changes",
      blurb: "Skipped or changed instances in a recurring series.",
    },
    // The overriding occurrence's guest list, rows rather than JSON (#916, R6):
    // party ids inside a blob are invisible to identity merge and to the purge
    // cascade.
    recurrence_exception_attendee: {
      lifecycle: "mutable",
      projectionOf: "schedule.recurrence_exception",
      label: "Recurrence guests",
      blurb: "Who is invited to a changed instance of a recurring event.",
    },
  },
  // `contact_card` is gone (#883, ruling O-contact): an identifier is not a
  // channel and a card was neither — its role line is `people.profile.role`,
  // its nickname `people.profile.nickname`, and reachability has one owner in
  // `contact_channel`.
  social: {
    contact_channel: {
      lifecycle: "mutable",
      label: "Contact channels",
      blurb: "Validated phone, email, address, and handle details.",
    },
    circle: {
      label: "Circles",
      blurb: "Groups of people in your life.",
      lifecycle: "mutable",
    },
    circle_member: {
      lifecycle: "mutable",
      label: "Circle members",
      blurb: "Who belongs to each circle.",
    },
    thread: {
      label: "Threads",
      blurb: "Message threads with people.",
      lifecycle: "mutable",
    },
    thread_participant: {
      lifecycle: "mutable",
      label: "Participants",
      blurb: "Who's in each thread.",
    },
    message: {
      lifecycle: "mutable",
      label: "Messages",
      blurb: "Individual messages you've exchanged.",
    },
  },
  knowledge: {
    note: {
      label: "Notes",
      blurb: "Things you've written down.",
      lifecycle: "trash",
    },
    annotation: {
      lifecycle: "mutable",
      label: "Annotations",
      blurb: "Notes pinned to a spot in something.",
    },
  },
  media: {
    asset: {
      label: "Media",
      blurb: "Your photos and videos.",
      lifecycle: "trash",
    },
    face_region: {
      label: "Faces",
      blurb: "Faces found in your photos.",
      lifecycle: "mutable",
    },
    asset_phash: {
      lifecycle: "mutable",
      projectionOf: "media.asset",
      label: "Fingerprints",
      blurb: "Hashes for spotting duplicate photos.",
    },
    // Memories v0 (#724): a rebuildable projection over signals the
    // vault already carries — see schema/enrich.ts's header for the shape and
    // enrich/memories.ts for the sweep that (re)derives it. Registered here
    // (not a new column on media_asset) for the same reason
    // media_asset_phash is a sidecar: this is app-reachable derived data, and
    // registering it under the existing `{schema:'media', verbs:'read'}`
    // grant scope (packages/blueprints/apps/photos/app.json) means no app
    // manifest or mobile consent change is needed to read it.
    memory: {
      lifecycle: "append-only",
      label: "Memories",
      blurb: "Moments gathered from your photos.",
    },
    memory_member: {
      lifecycle: "append-only",
      projectionOf: "media.memory",
      label: "Memory photos",
      blurb: "Which photos belong to each memory.",
    },
    // Faces (#724): the unnamed-face grouping projection — see
    // schema/enrich.ts's header for why identity is NOT in it. Registered for
    // the same two reasons `memory` is: it is app-reachable derived data, so
    // the existing `{schema:'media', verbs:'read'}` grant scope covers it with
    // no manifest change, and registration is what installs the replica
    // change-log triggers, so a rebuild (or a person-forget cascade) reaches an
    // offline phone like any other row change.
    face_cluster: {
      lifecycle: "mutable",
      projectionOf: "media.face_region",
      label: "Face groups",
      blurb: "Faces that look like each other, waiting for a name.",
    },
  },
  // `home` and `business` are gone (#883, ruling O-domains): ten tables with
  // zero blueprint consumers, dropped from the v0 ontology in wave two. Their
  // product case is proposal
  // [#885](https://github.com/srikanth235/centraid/issues/885) — intent belongs
  // in an issue, not in dormant DDL, and the ideal state carries no
  // undocumented dormant domain.
  people: {
    profile: {
      lifecycle: "trash",
      label: "Profiles",
      blurb: "Personal notes about people you know.",
    },
    important_date: {
      lifecycle: "trash",
      label: "Important dates",
      blurb: "Birthdays and anniversaries to remember.",
    },
  },
  // `item_alias` was DDL-only until #872: the connector alias existed, was
  // written and was resolvable at reveal time, but an unregistered table is
  // outside the canonical walk — so it never exported, never got a replica
  // change-log trigger, and no app could read it back (README-Locker §8's
  // first paper cut). The sidecars that follow are registered for the same
  // reasons: `item_field` is the member's own sections and fields (and the
  // storage every new item type is built from), `item_address` the extra
  // addresses a login answers to, `item_passkey` the passkey slot, and
  // `item_history` the durable item/password history. Each is either a fact
  // the owner entered or a record only this vault holds; a restore that
  // dropped one would hand back a locker that had forgotten it.
  locker: {
    item: {
      lifecycle: "trash",
      label: "Secrets",
      blurb: "Passwords and codes kept under lock.",
      // #916, D2: a swept-away previous password is a credential the member
      // can no longer recover, so the Locker and its sidecars keep every
      // snapshot. This is what `locker_item_history` used to be — a whole
      // second revision table for one retention rule.
      revisions: { retain: "forever" },
    },
    item_address: {
      lifecycle: "append-only",
      label: "Addresses",
      blurb: "Extra web addresses a login answers to.",
      revisions: { retain: "forever" },
    },
    item_alias: {
      lifecycle: "append-only",
      revisions: { retain: "forever" },
      // Its key is a WORD the member chose; entity ids are one opaque
      // namespace and an alias must not occupy one (#916, entity.ts header).
      projectionOf: "locker.item",
      label: "Aliases",
      blurb: "Short names a connector binds to instead of an id.",
    },
    item_field: {
      lifecycle: "mutable",
      label: "Custom fields",
      blurb: "Sections and fields you added to an item yourself.",
      revisions: { retain: "forever" },
    },
    // `item_history` is GONE (#916, owner decision D2): it was a SECOND
    // revision mechanism beside `core.entity_revision`, with its own
    // retention, its own undo path and its own export shape for one fact. A
    // Locker revision is a `core.entity_revision` row with
    // `entity_type = 'locker.item'`; the old values ride in `snapshot_json`
    // exactly as the sidecar stored them, sealed columns still ciphertext.
    item_passkey: {
      lifecycle: "mutable",
      projectionOf: "locker.item",
      label: "Passkeys",
      blurb: "Passkey details kept beside the login they belong to.",
      revisions: { retain: "forever" },
    },
  },
  sync: {
    connection: { label: "Connections", lifecycle: "machinery" },
    external_entity: { label: "External ids", lifecycle: "machinery" },
    import_batch: { label: "Import batches", lifecycle: "machinery" },
    import_row: { label: "Imported rows", lifecycle: "machinery" },
    connection_cursor: { label: "Sync cursors", lifecycle: "machinery" },
    connection_run: { label: "Sync runs", lifecycle: "machinery" },
    connection_credential: {
      label: "Connection credentials",
      lifecycle: "machinery",
    },
    connection_health: { label: "Connection health", lifecycle: "machinery" },
  },
  tally: {
    friend: {
      label: "Friends",
      blurb: "People you split expenses with.",
      lifecycle: "mutable",
    },
    group: {
      label: "Groups",
      blurb: "Groups you share expenses in.",
      lifecycle: "mutable",
    },
    expense: {
      label: "Expenses",
      blurb: "Shared costs you've recorded.",
      lifecycle: "trash",
    },
    expense_split: {
      lifecycle: "mutable",
      projectionOf: "tally.expense",
      label: "Expense splits",
      blurb: "Who owes what on each expense.",
    },
    // The template's split, rows rather than JSON (#916, owner decision D3) —
    // the same fact `expense_split` holds, about a template.
    recurring_expense_split: {
      lifecycle: "mutable",
      projectionOf: "tally.recurring_expense",
      label: "Recurring splits",
      blurb: "Who owes what each time a recurring expense lands.",
    },
    expense_payer: {
      lifecycle: "mutable",
      projectionOf: "tally.expense",
      label: "Expense payers",
      blurb: "Who put money down on each expense, and how much.",
    },
    // `expense_receipt` is gone (#883, ruling O-attach): a receipt is a
    // `core.attachment` with `role='receipt'` on the expense, which is what the
    // capture command was already writing beside the app-local row.
    expense_line_item: {
      lifecycle: "mutable",
      label: "Receipt lines",
      blurb: "The individual lines on a receipt.",
    },
    expense_line_allocation: {
      lifecycle: "mutable",
      projectionOf: "tally.expense_line_item",
      label: "Line shares",
      blurb: "Who each receipt line is assigned to.",
    },
    recurring_expense: {
      lifecycle: "mutable",
      label: "Recurring expenses",
      blurb: "Expense templates scheduled for future materialization.",
    },
    settlement: {
      lifecycle: "trash",
      label: "Settlements",
      blurb: "Payments that settle up debts.",
    },
    obligation: {
      lifecycle: "trash",
      label: "Obligations",
      blurb: "Who owes whom, as running totals.",
    },
    nudge: {
      lifecycle: "mutable",
      label: "Prepared reminders",
      blurb: "Reminders you prepared about a balance. Nothing is ever sent.",
    },
  },
  // `derivation` (#724 W2's provenance stamp) is registered here for the
  // reason `portable-export.ts`'s own audit note already assumes it is: the
  // canonical table walk IS this list, so an unregistered table is silently
  // absent from every export AND gets no replica change-log trigger. Both
  // matter for the face-delete gate (#724): a stamp left behind after
  // `media.forget_person` would survive a restore and would never reach an
  // offline phone, and it is the row that tells the next sweep those faces
  // are current.
  // `policy_rule` (#807) is registered for the same two reasons: it is an OWNER
  // DECISION, so a portable restore that dropped it would hand back a vault
  // that had forgotten which scopes enrich with what. Registration also
  // installs the replica change-log triggers, which is what lets a phone show
  // the effective policy it is governed by. The egress ANSWERS that used to sit
  // beside it as `enrich.consent` are rows of `share.authority` since #883 —
  // one plane for every standing answer — and are registered there.
  enrich: {
    embedding: {
      label: "Embeddings",
      lifecycle: "machinery",
      // The ONE genuinely binary column in the registry: little-endian
      // float32 vectors. Deferred by declaration, not by weight (#922).
      replicaValues: { lazyColumns: ["vector"] },
    },
    request: { label: "Enrichment requests", lifecycle: "machinery" },
    policy: { label: "Enrichment policy", lifecycle: "machinery" },
    derivation: { label: "Enrichment provenance", lifecycle: "machinery" },
    policy_rule: { label: "Enrichment rules", lifecycle: "machinery" },
  },
  outbox: {
    item: { label: "Outbox items", lifecycle: "machinery" },
    grant: { label: "Outbox grants", lifecycle: "machinery" },
  },
  // Commons control truth and local mechanics (#731). These must stay in the
  // canonical walk: a portable restore without the grant/roster bindings,
  // ordered op log, cursors, intent overlay, or pending invitations would
  // silently turn shared content into an unrelated local copy.
  share: {
    party_vault_binding: { label: "Vault bindings", lifecycle: "machinery" },
    circle_grant: { label: "Circle grants", lifecycle: "machinery" },
    commons_member_state: { label: "Member state", lifecycle: "machinery" },
    commons_op: { label: "Commons operations", lifecycle: "machinery" },
    commons_replay: { label: "Replayed operations", lifecycle: "machinery" },
    commons_receipt: { label: "Commons receipts", lifecycle: "machinery" },
    commons_cursor: { label: "Commons cursors", lifecycle: "machinery" },
    commons_lineage: { label: "Commons lineage", lifecycle: "machinery" },
    commons_retained: { label: "Retained commons", lifecycle: "machinery" },
    commons_intent: { label: "Commons intents", lifecycle: "machinery" },
    commons_invitation: { label: "Invitations", lifecycle: "machinery" },
    // The authority plane (#825, unified by #883). `authority` is EVERY
    // standing answer the member has given — to a person, a circle, a harness
    // or one of their own devices — `delivery_config` the per-grant
    // delivery-strategy ceiling, and `fulfillment` the per-audience-vault
    // delivery state. All three must ride the canonical walk, or a restore
    // would hand back a vault that had forgotten who it shares with, which
    // engines it agreed to, and which devices it trusts — and would re-deliver
    // everything it had already sent.
    authority: { label: "Access answers", lifecycle: "machinery" },
    // What an automation has ASKED for and the member has not decided yet
    // (#928). Registered, not local: a restore that forgot the open ask would
    // silently drop a question the member was about to be shown, and the
    // automation's next mount would park it again as if it were new.
    authority_request: { label: "Pending asks", lifecycle: "machinery" },
    delivery_config: { label: "Delivery limits", lifecycle: "machinery" },
    fulfillment: { label: "Delivery state", lifecycle: "machinery" },
    // #916, R8 / review 6.4: these four were in `LOCAL_TABLES` as "device
    // observation", which contradicted the comment above — they are Commons
    // CONTROL truth, and a restore without them hands back a seat that has
    // forgotten which op hashes it verified, which recovery it is the
    // successor of, and how far behind its steward it had fallen. Being
    // unregistered also meant no replica change-log trigger, so none of it
    // ever reached a second device. Machinery, like the rest of the band.
    commons_verified: { label: "Verified checkpoints", lifecycle: "machinery" },
    commons_supersession: {
      label: "Commons recovery lineage",
      lifecycle: "machinery",
    },
    commons_device_reach: { label: "Device reach", lifecycle: "machinery" },
    commons_steward_contact: {
      label: "Steward contact",
      lifecycle: "machinery",
    },
  },
  notifications: { notice: { label: "Notices", lifecycle: "machinery" } },
  // Read-only custody projections, both rebuilt on the standing sweep:
  // `custody_state` (#352) is local-vs-replicated state per content item;
  // `custody_rollup` (#711) is its aggregate — per-bucket counts and
  // bytes, including how much of the local tier is provably safe to release.
  // See blob/custody.ts and blob/custody-rollup.ts.
  blob: {
    custody_state: { label: "Custody", lifecycle: "machinery" },
    custody_rollup: { label: "Custody totals", lifecycle: "machinery" },
  },
};

function tableNamesOf(registry: EntityRegistry): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(registry).map(([schema, entities]) => [
      schema,
      Object.keys(entities),
    ])
  );
}

/**
 * The canonical walk, as bare table names. DERIVED from `VAULT_ENTITIES` — the
 * declarations above are the one place a table is added or removed, and this
 * view exists so the callers that only ever needed the names (the export walk,
 * the change-log trigger installer, the consent resolver) did not have to
 * learn the richer shape when it grew a label.
 */
export const VAULT_TABLES: Readonly<Record<string, readonly string[]>> =
  tableNamesOf(VAULT_ENTITIES);
