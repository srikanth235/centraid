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
    },
    content_derivative: {
      lifecycle: "mutable",
      label: "Derivatives",
      blurb: "Thumbnails and previews made from content.",
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
    entity_revision: {
      lifecycle: "mutable",
      label: "Entity history",
      blurb: "Pre-mutation snapshots for version history and undo.",
    },
    share_origin: {
      lifecycle: "mutable",
      projectionOf: "core.entity",
      label: "Shared with here",
      blurb: "Where an item placed in this space came from, and who placed it.",
    },
  },
  access: {
    app: { label: "Installed apps", lifecycle: "machinery" },
    agent: { label: "Agent registrations", lifecycle: "machinery" },
    app_ext: { label: "App tables", lifecycle: "machinery" },
    grant: { label: "App grants", lifecycle: "machinery" },
    grant_scope: { label: "Grant scopes", lifecycle: "machinery" },
    scope_tombstone: { label: "Withdrawn scopes", lifecycle: "machinery" },
    scope_request: { label: "Scope requests", lifecycle: "machinery" },
    policy: { label: "Policies", lifecycle: "machinery" },
    device: { label: "Devices", lifecycle: "machinery" },
    seed_row: { label: "Seeded rows", lifecycle: "machinery" },
  },
  agent: {
    command: { label: "Agent commands", lifecycle: "machinery" },
    capability: { label: "Agent capabilities", lifecycle: "machinery" },
  },
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
    recurrence_exception_attendee: {
      lifecycle: "mutable",
      projectionOf: "schedule.recurrence_exception",
      label: "Recurrence guests",
      blurb: "Who is invited to a changed instance of a recurring event.",
    },
  },
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
    face_cluster: {
      lifecycle: "mutable",
      projectionOf: "media.face_region",
      label: "Face groups",
      blurb: "Faces that look like each other, waiting for a name.",
    },
  },
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
  locker: {
    item: {
      lifecycle: "trash",
      label: "Secrets",
      blurb: "Passwords and codes kept under lock.",
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
  enrich: {
    embedding: { label: "Embeddings", lifecycle: "machinery" },
    request: { label: "Enrichment requests", lifecycle: "machinery" },
    policy: { label: "Enrichment policy", lifecycle: "machinery" },
    derivation: { label: "Enrichment provenance", lifecycle: "machinery" },
    policy_rule: { label: "Enrichment rules", lifecycle: "machinery" },
  },
  outbox: {
    item: { label: "Outbox items", lifecycle: "machinery" },
    grant: { label: "Outbox grants", lifecycle: "machinery" },
  },
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
    authority: { label: "Access answers", lifecycle: "machinery" },
    delivery_config: { label: "Delivery limits", lifecycle: "machinery" },
    fulfillment: { label: "Delivery state", lifecycle: "machinery" },
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

export const VAULT_TABLES: Readonly<Record<string, readonly string[]>> =
  tableNamesOf(VAULT_ENTITIES);
