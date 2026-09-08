// THE APP DOMAINS of the entity registry (#996 wave 7).
//
// Split out of `entity-catalog.ts` for the repo's file-size rule, along the one
// seam the registry actually has: `entity-catalog.ts` keeps the CORE and the
// MACHINERY bands — the vault's own identity, the access plane, agents,
// enrichment, the outbox, notices, the sharing plane and blob custody — and
// this file holds the eight schemas a bundled app owns. The declarations are
// unchanged; `VAULT_ENTITIES` spreads the two, so there is still exactly one
// place a table is added and exactly one registry to read.

import type { EntityRegistry } from "./entity-declaration.js";

export const VAULT_DOMAIN_ENTITIES: EntityRegistry = {
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
};
