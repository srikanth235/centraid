// Logical ↔ physical name registry. The ontology speaks schema-qualified
// logical names (`core.party`) — grants, receipts, links and polymorphic refs
// all store them. SQLite has no namespaces, so physical tables are
// underscore-joined (`core_party`). The gateway translates through this
// registry only, which doubles as an allow-list: unknown entity names never
// reach SQL.
//
// The registry has a static half (the canonical ontology below) and a
// dynamic half (#286): app-declared ext-band tables recorded
// in `consent_app_ext`. Callers that pass their vault handle resolve both;
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

/**
 * What one registered entity is, beyond its existence.
 *
 * `label` is the member-facing name every surface shows — required, because a
 * nameless entity is what forced four maps to invent a name each.
 *
 * `blurb` is the one-line plain-English description the Atlas's Relations page
 * shows. It is present for ONTOLOGY kinds (the owner's life data) and
 * deliberately absent for machinery bands: we name the plumbing, but we never
 * fabricate a description for it. Blurbs stay short (≤ ~60 chars), concrete,
 * and honour docs/glossary.md — never "chat" for the ledger, no
 * "entity"/"record"/"FK".
 */
export interface VaultEntityDeclaration {
  label: string;
  blurb?: string;
}

export type EntityRegistry = Readonly<
  Record<string, Readonly<Record<string, VaultEntityDeclaration>>>
>;

export const VAULT_ENTITIES: EntityRegistry = {
  core: {
    vault: {
      label: "Vault",
      blurb: "This vault itself — its name and identity.",
    },
    party: {
      label: "People",
      blurb: "Everyone you know — people and organisations.",
    },
    party_identifier: {
      label: "Identifiers",
      blurb: "Emails, phones and handles for each person.",
    },
    place: { label: "Places", blurb: "Locations that matter to you." },
    event: {
      label: "Events",
      blurb: "Things that happened or will happen.",
    },
    account: {
      label: "Accounts",
      blurb: "Money accounts — bank, card, wallet.",
    },
    transaction: {
      label: "Transactions",
      blurb: "Money moving in and out of your accounts.",
    },
    content_item: { label: "Content", blurb: "Files and media you've saved." },
    content_derivative: {
      label: "Derivatives",
      blurb: "Thumbnails and previews made from content.",
    },
    document: { label: "Documents", blurb: "Your documents and their text." },
    attachment: {
      label: "Attachments",
      blurb: "Files pinned to other things.",
    },
    activity: { label: "Activity", blurb: "A log of what you've done." },
    observation: {
      label: "Observations",
      blurb: "Measured readings about you or your things.",
    },
    observation_component: {
      label: "Readings",
      blurb: "The individual values inside an observation.",
    },
    link: {
      label: "Links",
      blurb: "Connections you've drawn between things.",
    },
    link_anchor: {
      label: "Anchors",
      blurb: "Where a link points inside a document.",
    },
    concept_scheme: {
      label: "Vocabularies",
      blurb: "Named sets of tags and categories.",
    },
    concept: {
      label: "Concepts",
      blurb: "The tags and categories themselves.",
    },
    tag: { label: "Tags", blurb: "Labels you put on things." },
    collection: {
      label: "Collections",
      blurb: "Groups of things you've gathered.",
    },
    collection_entry: {
      label: "Collection items",
      blurb: "What's inside each collection.",
    },
    // P5 pre-mutation snapshots. Grants row-filter this by entity_type.
    entity_revision: {
      label: "Entity history",
      blurb: "Pre-mutation snapshots for version history and undo.",
    },
    // Share-by-placement provenance (#599). Registered so a merged
    // multi-scope app view can read the audience + who-placed-it badge for a
    // projected row like any other table.
    share_origin: {
      label: "Shared with here",
      blurb: "Where an item placed in this space came from, and who placed it.",
    },
  },
  consent: {
    app: { label: "Installed apps" },
    agent: { label: "Agent registrations" },
    app_ext: { label: "App tables" },
    app_view: { label: "App views" },
    access_grant: { label: "App grants" },
    grant_scope: { label: "Grant scopes" },
    scope_tombstone: { label: "Withdrawn scopes" },
    scope_request: { label: "Scope requests" },
    policy: { label: "Policies" },
    device: { label: "Devices" },
    export_job: { label: "Export jobs" },
    seed_row: { label: "Seeded rows" },
  },
  agent: {
    command: { label: "Agent commands" },
    capability: { label: "Agent capabilities" },
    correction: { label: "Corrections" },
    judgment: { label: "Judgments" },
  },
  health: {
    vital: {
      label: "Vitals",
      blurb: "Body readings — heart rate, weight, and more.",
    },
    workout: { label: "Workouts", blurb: "Exercise sessions you've logged." },
    sleep_session: { label: "Sleep", blurb: "Nights of sleep you've tracked." },
    medication_course: {
      label: "Medications",
      blurb: "Medicines you take and when.",
    },
    condition: {
      label: "Conditions",
      blurb: "Health conditions you're tracking.",
    },
  },
  finance: {
    txn_split: {
      label: "Splits",
      blurb: "Parts of a transaction across categories.",
    },
    budget: { label: "Budgets", blurb: "Spending limits you've set." },
    holding: { label: "Holdings", blurb: "Investments you own." },
    recurring_series: {
      label: "Recurring",
      blurb: "Payments that repeat on a schedule.",
    },
    fx_rate: { label: "Exchange rates", blurb: "Currency conversion rates." },
  },
  schedule: {
    calendar: {
      label: "Calendars",
      blurb: "Your calendars — work, home, and more.",
    },
    event_ext: {
      label: "Event details",
      blurb: "Extra scheduling detail on an event.",
    },
    attendee: { label: "Guests", blurb: "Who's invited to each event." },
    task: { label: "Tasks", blurb: "Things to do, with due dates." },
    project: {
      label: "Task projects",
      blurb: "Ordered projects and areas for tasks.",
    },
    section: {
      label: "Task sections",
      blurb: "Ordered sections within a task project.",
    },
    recurrence_exception: {
      label: "Recurrence changes",
      blurb: "Skipped or changed instances in a recurring series.",
    },
    availability_rule: {
      label: "Availability",
      blurb: "When you're free to meet.",
    },
  },
  // `contact_card` is gone (#883, ruling O-contact): an identifier is not a
  // channel and a card was neither — its role line is `people.profile.role`,
  // its nickname `people.profile.nickname`, and reachability has one owner in
  // `contact_channel`.
  social: {
    contact_channel: {
      label: "Contact channels",
      blurb: "Validated phone, email, address, and handle details.",
    },
    circle: { label: "Circles", blurb: "Groups of people in your life." },
    circle_member: {
      label: "Circle members",
      blurb: "Who belongs to each circle.",
    },
    thread: { label: "Threads", blurb: "Message threads with people." },
    thread_participant: {
      label: "Participants",
      blurb: "Who's in each thread.",
    },
    message: {
      label: "Messages",
      blurb: "Individual messages you've exchanged.",
    },
  },
  knowledge: {
    note: { label: "Notes", blurb: "Things you've written down." },
    annotation: {
      label: "Annotations",
      blurb: "Notes pinned to a spot in something.",
    },
  },
  media: {
    asset: { label: "Media", blurb: "Your photos and videos." },
    face_region: { label: "Faces", blurb: "Faces found in your photos." },
    asset_phash: {
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
      label: "Memories",
      blurb: "Moments gathered from your photos.",
    },
    memory_member: {
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
      label: "Profiles",
      blurb: "Personal notes about people you know.",
    },
    important_date: {
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
      label: "Secrets",
      blurb: "Passwords and codes kept under lock.",
    },
    item_address: {
      label: "Addresses",
      blurb: "Extra web addresses a login answers to.",
    },
    item_alias: {
      label: "Aliases",
      blurb: "Short names a connector binds to instead of an id.",
    },
    item_field: {
      label: "Custom fields",
      blurb: "Sections and fields you added to an item yourself.",
    },
    item_history: {
      label: "Item history",
      blurb: "What changed on an item, and the passwords it had before.",
    },
    item_passkey: {
      label: "Passkeys",
      blurb: "Passkey details kept beside the login they belong to.",
    },
  },
  sync: {
    connection: { label: "Connections" },
    external_entity: { label: "External ids" },
    import_batch: { label: "Import batches" },
    import_row: { label: "Imported rows" },
    connection_cursor: { label: "Sync cursors" },
    connection_run: { label: "Sync runs" },
    connection_credential: { label: "Connection credentials" },
    connection_health: { label: "Connection health" },
  },
  tally: {
    friend: { label: "Friends", blurb: "People you split expenses with." },
    group: { label: "Groups", blurb: "Groups you share expenses in." },
    expense: { label: "Expenses", blurb: "Shared costs you've recorded." },
    expense_split: {
      label: "Expense splits",
      blurb: "Who owes what on each expense.",
    },
    expense_payer: {
      label: "Expense payers",
      blurb: "Who put money down on each expense, and how much.",
    },
    // `expense_receipt` is gone (#883, ruling O-attach): a receipt is a
    // `core.attachment` with `role='receipt'` on the expense, which is what the
    // capture command was already writing beside the app-local row.
    expense_line_item: {
      label: "Receipt lines",
      blurb: "The individual lines on a receipt.",
    },
    expense_line_allocation: {
      label: "Line shares",
      blurb: "Who each receipt line is assigned to.",
    },
    recurring_expense: {
      label: "Recurring expenses",
      blurb: "Expense templates scheduled for future materialization.",
    },
    settlement: {
      label: "Settlements",
      blurb: "Payments that settle up debts.",
    },
    obligation: {
      label: "Obligations",
      blurb: "Who owes whom, as running totals.",
    },
    nudge: {
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
    embedding: { label: "Embeddings" },
    request: { label: "Enrichment requests" },
    policy: { label: "Enrichment policy" },
    derivation: { label: "Enrichment provenance" },
    policy_rule: { label: "Enrichment rules" },
  },
  outbox: {
    item: { label: "Outbox items" },
    grant: { label: "Outbox grants" },
  },
  // Commons control truth and local mechanics (#731). These must stay in the
  // canonical walk: a portable restore without the grant/roster bindings,
  // ordered op log, cursors, intent overlay, or pending invitations would
  // silently turn shared content into an unrelated local copy.
  share: {
    party_vault_binding: { label: "Vault bindings" },
    circle_grant: { label: "Circle grants" },
    commons_member_state: { label: "Member state" },
    commons_op: { label: "Commons operations" },
    commons_replay: { label: "Replayed operations" },
    commons_receipt: { label: "Commons receipts" },
    commons_cursor: { label: "Commons cursors" },
    commons_lineage: { label: "Commons lineage" },
    commons_retained: { label: "Retained commons" },
    commons_intent: { label: "Commons intents" },
    commons_invitation: { label: "Invitations" },
    // The authority plane (#825, unified by #883). `authority` is EVERY
    // standing answer the member has given — to a person, a circle, a harness
    // or one of their own devices — `delivery_config` the per-grant
    // delivery-strategy ceiling, and `fulfillment` the per-audience-vault
    // delivery state. All three must ride the canonical walk, or a restore
    // would hand back a vault that had forgotten who it shares with, which
    // engines it agreed to, and which devices it trusts — and would re-deliver
    // everything it had already sent.
    authority: { label: "Access answers" },
    delivery_config: { label: "Delivery limits" },
    fulfillment: { label: "Delivery state" },
  },
  notifications: { notice: { label: "Notices" } },
  // Read-only custody projections, both rebuilt on the standing sweep:
  // `custody_state` (#352) is local-vs-replicated state per content item;
  // `custody_rollup` (#711) is its aggregate — per-bucket counts and
  // bytes, including how much of the local tier is provably safe to release.
  // See blob/custody.ts and blob/custody-rollup.ts.
  blob: {
    custody_state: { label: "Custody" },
    custody_rollup: { label: "Custody totals" },
  },
};

/** journal.db entities — the append-only audit stream. */
export const JOURNAL_ENTITIES: EntityRegistry = {
  consent: {
    provenance: { label: "Provenance" },
    receipt: { label: "Receipts" },
  },
  agent: {
    command_invocation: { label: "Command invocations" },
    invocation_check: { label: "Invocation checks" },
    evidence: { label: "Evidence" },
    explanation: { label: "Explanations" },
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

/** journal.db tables — the append-only audit stream. */
export const JOURNAL_TABLES: Readonly<Record<string, readonly string[]>> =
  tableNamesOf(JOURNAL_ENTITIES);
