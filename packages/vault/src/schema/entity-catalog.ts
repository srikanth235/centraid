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

import { VAULT_DOMAIN_ENTITIES } from "./entity-catalog-domains.js";
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
    // THE INTERPRETATION, OWNED (#996, ruling R20(b), drift ONT-28). What one
    // owner takes a content item's bytes to BE — media type, charset, use.
    // An ENTITY, not a projection: a generated caption is a derived row keyed
    // to the representation (OQ-9), and an annotation can only target a row
    // the supertype knows.
    content_representation: {
      lifecycle: "mutable",
      label: "Representations",
      blurb: "How each owner reads the bytes it saved.",
    },
    // DECODED BODY TEXT (#996, rulings R4 / R8). A 1:1 projection of the
    // content row it decodes: it has no identity of its own, and a wide
    // column on `core_content_item` would make every read of that hot table
    // pay for text nobody asked for. It replicates, because from wave 1 the
    // FTS sync triggers index THIS column on every seat instead of calling an
    // application-defined SQL function no phone binding can register.
    content_text: {
      lifecycle: "mutable",
      projectionOf: "core.content_item",
      label: "Body text",
      blurb: "The searchable text of a file, decoded once when it is saved.",
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
  // THE EIGHT APP-OWNED SCHEMAS live in `entity-catalog-domains.ts` — one
  // registry still, split only because this file outgrew the repo size rule.
  // SPREAD IN PLACE, exactly where the declarations stood: a replica shape id
  // is a digest over the composed columns IN REGISTRY ORDER, so moving the
  // spread to the top of the object rebootstraps every device that holds any
  // shape — which a file split must never do.
  ...VAULT_DOMAIN_ENTITIES,
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
  },
  // The sharing plane's control truth (#731, #929). These must stay in the
  // canonical walk: a portable restore without the bindings, the standing
  // answers, the delivery state or the subscription lineage would silently turn
  // shared content into an unrelated local copy.
  share: {
    party_vault_binding: { label: "Vault bindings", lifecycle: "machinery" },
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
    // WHEN each answer was last exercised (#928) — what Settings → Access
    // draws beside every row. Registered because "you granted this a year ago
    // and nothing has used it since" is the fact that makes a stale answer
    // visible, and a restore that forgot it would silently reset every row to
    // "never used".
    authority_use: { label: "Answer last used", lifecycle: "machinery" },
    delivery_config: { label: "Delivery limits", lifecycle: "machinery" },
    fulfillment: { label: "Delivery state", lifecycle: "machinery" },
    // The subscription seat (#929): which grants this vault holds rows for,
    // how far it has ingested, and which rows each grant placed. A restore
    // without them hands back a copy no revoke can reach.
    subscription: { label: "Subscriptions", lifecycle: "machinery" },
    subscription_lineage: {
      label: "Subscription lineage",
      lifecycle: "machinery",
      // Its key CARRIES its pointer — `(authority_id, target_type, target_id)`,
      // with a composite foreign key into the supertype — so a claim cannot
      // outlive the row it names; it names a target, it is not one (#916).
      projectionOf: "core.entity",
    },
    // The ORIGIN's membership state (#996, R10): what each grant's closure
    // held when it was last served. Rebuildable from the predicate, and still
    // in the walk — `entered_seq` is not, and it is what tells a re-entered
    // row from one the audience has held since the subscription began.
    subscription_member: {
      label: "Subscription membership",
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
