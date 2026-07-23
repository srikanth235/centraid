// The Vault Atlas mapping (issue #441 Part B, B4 item 1): table → kind → pack
// classification for the Operations "ontology at a glance" surface. This is
// the one small new artifact all three Atlas tabs (Kinds / Relations /
// Browse) share.
//
// The mapping is DERIVED from the logical↔physical registry (`tables.ts`) —
// it never hand-lists tables. `VAULT_TABLES` and `JOURNAL_TABLES` are the
// single source of truth for which tables exist; this module only adds the
// centraid-specific meaning a generic DB editor throws away: which schemas
// are ONTOLOGY packs (the owner's life data — people, documents, photos…)
// versus MACHINERY bands (the plumbing — consent, agents, sync, blobs, the
// journal). Life data vs plumbing is the visual statement the Kinds tab and
// the machinery shelf make (issue #441 B1).

import { JOURNAL_TABLES, VAULT_TABLES } from './tables.js';

/** Ontology packs — the owner's life data, one section per pack in Kinds. */
export type AtlasPackKind = 'ontology' | 'machinery';

/**
 * The ontology packs (issue #441 B1): every schema whose tables are the
 * owner's actual knowledge. Everything else in the registry is machinery.
 * Kept as an explicit set so a NEW pack schema fails loud (unclassified)
 * rather than silently landing in the wrong shelf — see `atlasTables`.
 */
export const ONTOLOGY_PACKS: readonly string[] = [
  'core',
  'health',
  'finance',
  'schedule',
  'social',
  'knowledge',
  'media',
  'home',
  'business',
  'people',
  'locker',
  'tally',
];

/**
 * Machinery bands (issue #441 B1 "machinery shelf"): the plumbing schemas.
 * `consent` and `agent` name tables in BOTH files — the vault-file consent
 * plane and the journal-file audit stream — and both are machinery, so a
 * schema-keyed classification is correct regardless of file.
 */
export const MACHINERY_BANDS: readonly string[] = [
  'consent',
  'agent',
  'sync',
  'enrich',
  'outbox',
  'blob',
];

/** Human labels per pack — the serif vocabulary the census sentence uses. */
export const ATLAS_PACK_LABELS: Readonly<Record<string, string>> = {
  core: 'Core',
  health: 'Health',
  finance: 'Finance',
  schedule: 'Schedule',
  social: 'Social',
  knowledge: 'Knowledge',
  media: 'Media',
  home: 'Home',
  business: 'Business',
  people: 'People',
  locker: 'Locker',
  tally: 'Tally',
  consent: 'Consent',
  agent: 'Agents',
  sync: 'Sync',
  enrich: 'Enrichment',
  outbox: 'Outbox',
  blob: 'Blobs',
};

/**
 * Curated, human-friendly display name + one-line plain-English blurb per
 * ONTOLOGY kind (issue #441 Relations page): the vocabulary the client shows
 * so the Relations page can speak human ("People — everyone you know") instead
 * of SQL ("core_party"). Keyed by logical `schema.table`, hand-maintained the
 * same way `ATLAS_PACK_LABELS` is — one entry per ontology kind.
 *
 * Machinery bands are deliberately absent: their node's `friendly` falls back
 * to the mechanical `humanizeKind` label and they carry NO blurb (we never
 * fabricate a description for plumbing). A curated `name` also overrides the
 * humanized `label`. Blurbs stay short (≤ ~60 chars), concrete, and honour
 * docs/glossary.md — never "chat" for the ledger, no "entity"/"record"/"FK".
 * Every key here is pinned to a real registry logical name by an atlas test,
 * so a typo or a removed kind fails loud rather than orphaning stale copy.
 */
export const ATLAS_KIND_FRIENDLY: Readonly<Record<string, { name: string; blurb: string }>> = {
  // core — the spine every other pack hangs off.
  'core.vault': { name: 'Vault', blurb: 'This vault itself — its name and identity.' },
  'core.party': { name: 'People', blurb: 'Everyone you know — people and organisations.' },
  'core.party_identifier': {
    name: 'Identifiers',
    blurb: 'Emails, phones and handles for each person.',
  },
  'core.place': { name: 'Places', blurb: 'Locations that matter to you.' },
  'core.event': { name: 'Events', blurb: 'Things that happened or will happen.' },
  'core.account': { name: 'Accounts', blurb: 'Money accounts — bank, card, wallet.' },
  'core.transaction': { name: 'Transactions', blurb: 'Money moving in and out of your accounts.' },
  'core.content_item': { name: 'Content', blurb: "Files and media you've saved." },
  'core.content_derivative': {
    name: 'Derivatives',
    blurb: 'Thumbnails and previews made from content.',
  },
  'core.document': { name: 'Documents', blurb: 'Your documents and their text.' },
  'core.attachment': { name: 'Attachments', blurb: 'Files pinned to other things.' },
  'core.activity': { name: 'Activity', blurb: "A log of what you've done." },
  'core.observation': {
    name: 'Observations',
    blurb: 'Measured readings about you or your things.',
  },
  'core.observation_component': {
    name: 'Readings',
    blurb: 'The individual values inside an observation.',
  },
  'core.link': { name: 'Links', blurb: "Connections you've drawn between things." },
  'core.link_anchor': { name: 'Anchors', blurb: 'Where a link points inside a document.' },
  'core.concept_scheme': { name: 'Vocabularies', blurb: 'Named sets of tags and categories.' },
  'core.concept': { name: 'Concepts', blurb: 'The tags and categories themselves.' },
  'core.tag': { name: 'Tags', blurb: 'Labels you put on things.' },
  'core.collection': { name: 'Collections', blurb: "Groups of things you've gathered." },
  'core.collection_entry': { name: 'Collection items', blurb: "What's inside each collection." },
  // health
  'health.vital': { name: 'Vitals', blurb: 'Body readings — heart rate, weight, and more.' },
  'health.workout': { name: 'Workouts', blurb: "Exercise sessions you've logged." },
  'health.sleep_session': { name: 'Sleep', blurb: "Nights of sleep you've tracked." },
  'health.medication_course': { name: 'Medications', blurb: 'Medicines you take and when.' },
  'health.condition': { name: 'Conditions', blurb: "Health conditions you're tracking." },
  // finance
  'finance.txn_split': { name: 'Splits', blurb: 'Parts of a transaction across categories.' },
  'finance.budget': { name: 'Budgets', blurb: "Spending limits you've set." },
  'finance.holding': { name: 'Holdings', blurb: 'Investments you own.' },
  'finance.recurring_series': { name: 'Recurring', blurb: 'Payments that repeat on a schedule.' },
  'finance.fx_rate': { name: 'Exchange rates', blurb: 'Currency conversion rates.' },
  // schedule
  'schedule.calendar': { name: 'Calendars', blurb: 'Your calendars — work, home, and more.' },
  'schedule.event_ext': { name: 'Event details', blurb: 'Extra scheduling detail on an event.' },
  'schedule.attendee': { name: 'Guests', blurb: "Who's invited to each event." },
  'schedule.task': { name: 'Tasks', blurb: 'Things to do, with due dates.' },
  'schedule.availability_rule': { name: 'Availability', blurb: "When you're free to meet." },
  // social
  'social.contact_card': { name: 'Contact cards', blurb: 'Address-book details for a person.' },
  'social.circle': { name: 'Circles', blurb: 'Groups of people in your life.' },
  'social.circle_member': { name: 'Circle members', blurb: 'Who belongs to each circle.' },
  'social.thread': { name: 'Threads', blurb: 'Message threads with people.' },
  'social.thread_participant': { name: 'Participants', blurb: "Who's in each thread." },
  'social.message': { name: 'Messages', blurb: "Individual messages you've exchanged." },
  // knowledge
  'knowledge.note': { name: 'Notes', blurb: "Things you've written down." },
  'knowledge.annotation': { name: 'Annotations', blurb: 'Notes pinned to a spot in something.' },
  // media
  'media.media_asset': { name: 'Media', blurb: 'Your photos and videos.' },
  'media.face_region': { name: 'Faces', blurb: 'Faces found in your photos.' },
  'media.asset_phash': { name: 'Fingerprints', blurb: 'Hashes for spotting duplicate photos.' },
  // home
  'home.asset_item': { name: 'Belongings', blurb: 'Things you own around the home.' },
  'home.warranty': { name: 'Warranties', blurb: 'Coverage on the things you own.' },
  'home.maintenance_plan': { name: 'Maintenance', blurb: 'Upkeep schedules for your things.' },
  'home.utility_meter': { name: 'Meters', blurb: 'Your utility meters.' },
  'home.meter_reading': { name: 'Meter readings', blurb: 'Readings taken from your meters.' },
  // business
  'business.client': { name: 'Clients', blurb: 'People and companies you work for.' },
  'business.project': { name: 'Projects', blurb: "Work you're doing for clients." },
  'business.time_entry': { name: 'Time entries', blurb: "Hours you've logged on work." },
  'business.invoice': { name: 'Invoices', blurb: "Bills you've sent to clients." },
  'business.invoice_line': { name: 'Invoice lines', blurb: 'The line items on an invoice.' },
  // people
  'people.profile': { name: 'Profiles', blurb: 'Personal notes about people you know.' },
  'people.important_date': {
    name: 'Important dates',
    blurb: 'Birthdays and anniversaries to remember.',
  },
  // locker
  'locker.item': { name: 'Secrets', blurb: 'Passwords and codes kept under lock.' },
  // tally
  'tally.friend': { name: 'Friends', blurb: 'People you split expenses with.' },
  'tally.group': { name: 'Groups', blurb: 'Groups you share expenses in.' },
  'tally.expense': { name: 'Expenses', blurb: "Shared costs you've recorded." },
  'tally.expense_split': { name: 'Expense splits', blurb: 'Who owes what on each expense.' },
  'tally.settlement': { name: 'Settlements', blurb: 'Payments that settle up debts.' },
  'tally.obligation': { name: 'Obligations', blurb: 'Who owes whom, as running totals.' },
};

const ONTOLOGY_SET = new Set(ONTOLOGY_PACKS);
const MACHINERY_SET = new Set(MACHINERY_BANDS);

/** Which shelf a schema belongs to, or undefined for an unknown schema. */
export function packKindOf(schema: string): AtlasPackKind | undefined {
  if (ONTOLOGY_SET.has(schema)) return 'ontology';
  if (MACHINERY_SET.has(schema)) return 'machinery';
  return undefined;
}

/** A human-friendly kind label out of the physical table's local name. */
export function humanizeKind(table: string): string {
  return table
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** One row of the Atlas mapping: a physical table with its pack identity. */
export interface AtlasTableEntry {
  /** Logical `schema.table`, the name grants/links/provenance store. */
  logical: string;
  /** SQLite schema half of the logical name (the pack). */
  schema: string;
  /** SQLite table half of the logical name (the kind). */
  table: string;
  /** Physical SQLite table name, e.g. `core_party`. */
  physical: string;
  /** Which file the table lives in. */
  file: 'vault' | 'journal';
  /** The pack (== schema); named separately so callers read intent, not SQL. */
  pack: string;
  /** Ontology (life data) vs machinery (plumbing). */
  packKind: AtlasPackKind;
  /** The pack's human label. */
  packLabel: string;
  /** The kind's human label. */
  label: string;
  /**
   * Curated display name, always present: the `ATLAS_KIND_FRIENDLY` value for
   * this kind, or the humanized `label` when the kind isn't curated (every
   * machinery band, and any ontology kind without a hand-written entry).
   */
  friendly: string;
  /**
   * Curated one-line blurb — present ONLY for kinds in `ATLAS_KIND_FRIENDLY`
   * (ontology). Absent for uncurated kinds; we never fabricate a description.
   */
  blurb?: string;
}

function entryFor(schema: string, table: string, file: 'vault' | 'journal'): AtlasTableEntry {
  const packKind = packKindOf(schema);
  if (packKind === undefined) {
    // A schema the registry lists but this module hasn't classified — fail
    // loud rather than mis-shelve. Adding a pack means adding it to
    // ONTOLOGY_PACKS or MACHINERY_BANDS (and its label), by design.
    throw new Error(
      `atlas: unclassified schema "${schema}" — add it to ONTOLOGY_PACKS or MACHINERY_BANDS`,
    );
  }
  const label = humanizeKind(table);
  const friendly = ATLAS_KIND_FRIENDLY[`${schema}.${table}`];
  return {
    logical: `${schema}.${table}`,
    schema,
    table,
    physical: `${schema}_${table}`,
    file,
    pack: schema,
    packKind,
    packLabel: ATLAS_PACK_LABELS[schema] ?? humanizeKind(schema),
    label,
    friendly: friendly?.name ?? label,
    ...(friendly ? { blurb: friendly.blurb } : {}),
  };
}

/**
 * Every registered table, mapped to its pack — derived from `VAULT_TABLES`
 * and `JOURNAL_TABLES`, never hand-listed. Vault-file tables first, then the
 * journal's audit bands. Ext-band (app-declared) tables are NOT included:
 * the Atlas maps the canonical ontology, not per-app scratch schemas.
 */
export function atlasTables(): AtlasTableEntry[] {
  const out: AtlasTableEntry[] = [];
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, 'vault'));
  }
  for (const [schema, tables] of Object.entries(JOURNAL_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, 'journal'));
  }
  return out;
}

/** Index the mapping by physical table name (both files). */
export function atlasTablesByPhysical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.physical, e]));
}

/** Index the mapping by logical `schema.table` name. */
export function atlasTablesByLogical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.logical, e]));
}
