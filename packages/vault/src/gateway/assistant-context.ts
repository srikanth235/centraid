// The assistant's map of the vault: live DDL + the ontology conventions a
// model needs to write CORRECT SQL over the canonical schema. Column names
// alone don't say that `works-for` is a link relation, that starred is a
// flags-scheme tag, or that note bodies live in core_content_item — this
// doc does. Built per turn from the live file so it never drifts from the
// schema, and kept prose-light: it is model context, not documentation.

import type { VaultDb } from '../db.js';
import { RELATIONS_SCHEME_URI } from '../commands/links.js';
import { FLAGS_SCHEME_URI, STARRED_NOTATION } from '../commands/flags.js';
import { FOLDER_SCHEME_URI } from '../commands/documents.js';
import { CIRCLE_SCHEME_URI } from '../commands/people.js';
import { SEARCHABLE } from '../schema/fts.js';
import { VAULT_TABLES } from '../schema/tables.js';
import { extPhysicalNames } from './ext.js';

const CONVENTIONS = `## Conventions
- Logical entities are schema-qualified (core.party); physical SQLite tables are underscore-joined (core_party). Polymorphic refs (core_link.from_type, core_tag.subject_type, …) store the LOGICAL name.
- Primary keys are UUIDv7 strings — lexicographic order IS creation-time order. Timestamps are ISO-8601 strings; compare with plain string comparison or the date() family.
- core.party is the universal person/org row (kind column). People, contacts, senders, attendees, clients all reference party_id.
- core_link is the ONLY cross-entity relationship fabric: (from_type, from_id) → (to_type, to_id) with relation_concept_id → core_concept. A live link has valid_to IS NULL; ended links keep their row (temporal, never deleted). Employment ("works-for"), references, about — all links.
- SKOS concepts (core_concept in core_concept_scheme) carry vocabulary: link relations, document folders, flags, people circles. core_tag pins a concept onto any entity (target_type, target_id, concept_id).
- Starred = a core_tag whose concept has notation '${STARRED_NOTATION}' in the flags scheme (${FLAGS_SCHEME_URI}).
- Canonical bytes/text live in core_content_item (content_uri is a data: URI). Use the SQL function vault_content_text(media_type, content_uri) to decode a body to text. Note/message bodies hang off *_content_id columns.
- Soft deletes: content has deleted_at, links have valid_to; filter them for "current" answers.
- Money: core_transaction.amount_minor is an INTEGER in minor units (divide by 100 for display) with its own currency column and a debit/credit direction.
- Sealed columns (issue #293): secret cells (locker_item password, otp_seed, card_number, cvv, content) are ciphertext at rest and show as «sealed» in results — you cannot SELECT their plaintext, and you must never try to. Derivatives come from typed commands (locker.watchtower, locker.totp_code).`;

const FTS_NOTE = `## Full-text search (joinable FTS5 tables)
Each fts_* table indexes its base table (join on the shared id column) and supports MATCH:
  SELECT b.* FROM fts_knowledge_note f JOIN knowledge_note b ON b.note_id = f.note_id
   WHERE fts_knowledge_note MATCH 'budget*' ORDER BY f.rank
Words in MATCH are FTS5 syntax — quote user text, use word* for prefix.`;

/** One relation/flag/etc. vocabulary line: notation — label. */
function schemeLines(db: VaultDb, uri: string): string[] {
  try {
    const rows = db.vault
      .prepare(
        `SELECT c.notation, c.pref_label FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE s.uri = ? ORDER BY c.notation`,
      )
      .all(uri) as { notation: string | null; pref_label: string | null }[];
    return rows
      .filter((r) => r.notation)
      .map(
        (r) =>
          `${r.notation}${r.pref_label && r.pref_label !== r.notation ? ` — ${r.pref_label}` : ''}`,
      );
  } catch {
    return [];
  }
}

/** Live CREATE TABLE statements: every canonical table + the live ext band. */
function ddl(db: VaultDb): string {
  const physical = new Set(
    Object.entries(VAULT_TABLES).flatMap(([schema, tables]) => tables.map((t) => `${schema}_${t}`)),
  );
  for (const name of extPhysicalNames(db.vault)) physical.add(name);
  const rows = db.vault
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND sql IS NOT NULL ORDER BY name`,
    )
    .all() as { name: string; sql: string }[];
  return rows
    .filter((r) => physical.has(r.name))
    .map((r) => `${r.sql};`)
    .join('\n');
}

/**
 * Build the schema + ontology context spliced into the vault assistant's
 * system prompt. Everything the model needs to answer with one good
 * SELECT: conventions, live DDL, the FTS surfaces, and the concept
 * vocabularies that make links/tags legible.
 */
export function buildAssistantContext(db: VaultDb): string {
  const sections: string[] = [CONVENTIONS];

  const relations = schemeLines(db, RELATIONS_SCHEME_URI);
  if (relations.length > 0) {
    sections.push(
      `## Link relations (core_link.relation_concept_id → core_concept.notation)\n${relations.join('\n')}`,
    );
  }
  const vocab: string[] = [];
  const flags = schemeLines(db, FLAGS_SCHEME_URI);
  if (flags.length > 0) vocab.push(`flags: ${flags.join(', ')}`);
  const folders = schemeLines(db, FOLDER_SCHEME_URI);
  if (folders.length > 0) vocab.push(`document folders: ${folders.join(', ')}`);
  const circles = schemeLines(db, CIRCLE_SCHEME_URI);
  if (circles.length > 0) vocab.push(`people circles: ${circles.join(', ')}`);
  if (vocab.length > 0) sections.push(`## Concept vocabularies\n${vocab.join('\n')}`);

  const fts = Object.values(SEARCHABLE)
    .map((s) => `${s.fts} (id: ${s.idColumn}; text: ${s.maskColumns.join(', ')})`)
    .join('\n');
  sections.push(`${FTS_NOTE}\n${fts}`);

  const extNames = extPhysicalNames(db.vault);
  if (extNames.length > 0) {
    sections.push(
      `## App extension tables (the ext band)\n` +
        `Tables named ext_<app>_<table> are app-declared extensions living beside the canonical model. ` +
        `Logical names are ext.<appId>.<table> (write via the ext.<appId>.insert/update/delete commands; ` +
        `link/tag them like any entity). Present: ${extNames.join(', ')}.`,
    );
  }

  const commands = registeredCommands(db);
  if (commands.length > 0) {
    sections.push(
      `## Typed commands (the ONLY write path — use the vault_invoke tool)\n` +
        `Invalid input returns the command's schema error; confirm-gated commands park for the owner's approval (risk is a salience marker, not a gate — issue #306).\n` +
        commands.join('\n'),
    );
  }

  sections.push(`## Schema (live DDL)\n${ddl(db)}`);
  return sections.join('\n\n');
}

/** One line per registered command: name — risk (+ parks note). */
function registeredCommands(db: VaultDb): string[] {
  try {
    const rows = db.vault
      .prepare(
        `SELECT c.name, c.risk, cap.requires_confirmation
           FROM agent_command c JOIN agent_capability cap ON cap.command_id = c.command_id
          ORDER BY c.name`,
      )
      .all() as { name: string; risk: string; requires_confirmation: number }[];
    // Only the capability's confirm flag parks (issue #306; #308 fixed the
    // annotation) — advertising risk-high as parking would teach the model
    // a gate that no longer exists.
    return rows.map(
      (r) =>
        `${r.name} — risk ${r.risk}${r.requires_confirmation === 1 ? ' (parks for owner approval)' : ''}`,
    );
  } catch {
    return [];
  }
}
