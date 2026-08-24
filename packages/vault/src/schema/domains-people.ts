// Personal-CRM DDL — schema `people`. The "keep in touch" surface: a curated
// set of the people the owner cares about, each a canonical core.party
// (kind='person') enriched with a 1:1 people_profile carrying the CRM-only
// facts the party spine doesn't model — the role line, the avatar hue, the
// keep-in-touch cadence, when they were last reached, and how they were met.
// Cross-domain facts do not get re-imported at table grain (#450):
// interactions are core_activity + annotation, tasks are schedule_task,
// relationships are core_link, debts are tally_obligation, and owner journal
// entries are knowledge_note, and gift ideas are typed schedule tasks linked
// to their recipient. The People band keeps only the two genuine CRM rows:
// profile and important dates.
//
// The pieces that already have a home in the ontology are NOT re-invented
// here (#274's rule): notes are knowledge.annotation on the party,
// favorites are the flags-scheme star on the party, and the owner files people
// into `lists` — SKOS concepts in the owner's `lists` scheme with membership
// one core.tag per person, the exact mechanism Docs folders use. Do not name
// this classification "circles" (#441): that name collides with
// social_circle (the AUDIENCE mechanism shares and Tally groups target), two
// unrelated things named identically. People's classification is "lists"
// end-to-end; social_circle keeps "circle". Journal entries are the
// one owner-level (not per-person) row, so they carry the owner party directly.
//
// Trash (#441): every owner-authored CONTENT row carries the uniform
// soft-delete pair `deleted_at` / `purge_at` with the CHECK guard
// (`purge_at IS NULL OR deleted_at IS NOT NULL`), matching Docs/Photos/Locker —
// so a delete here is a reversible grace-window trash, and the lifecycle sweep
// (gateway/duties.ts) is what finally purges and cleans the row's polymorphic
// references. #630 gives people_profile the same lifecycle in its forward
// migration: the profile is membership in the People projection, so trashing
// it hides the person without deleting the canonical party or linked facts.
//
// All tables STRICT; PKs are TEXT UUIDv7; money is fixed-scale INTEGER minor
// units; timestamps are TEXT ISO-8601 UTC — the core spine's conventions.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

// The profile's own columns, as the baseline rung creates them. Held in a
// constant rather than inlined because the cadence-floor rebuild below has to
// re-create this table with EXACTLY this shape: a table rebuild that drifts
// from the baseline would silently drop whatever column the baseline grew and
// the rebuild forgot. One text, two rungs, no drift.
const PEOPLE_PROFILE_COLUMNS = `
  profile_id        TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  role              TEXT,
  avatar_color      TEXT,
  -- 0 means "never" — cadence disabled (issue #821). Some people the owner
  -- keeps are people they never want nagged about, and the floor of 1 day had
  -- no way to say so; a zero-cadence person is never overdue. Negative days
  -- stay refused: the CHECK is the storage floor, and the People command
  -- schemas above it carry the same minimum of 0.
  cadence_days      INTEGER NOT NULL CHECK (cadence_days >= 0),
  -- Ground fact, NOT a projection (issue #441 A3): last_contacted_at is stamped
  -- by an explicit owner gesture — logging an interaction (people.log_interaction)
  -- sets it to now, and that is the only writer. It is deliberately NOT a cache
  -- of MAX(core_activity.started_at) through a live about-link: a logged touch is what clears
  -- "overdue", and the owner may log a touch with no interaction body, or keep
  -- an interaction they later trash without un-clearing overdue. So it needs no
  -- rebuild sweep — there is nothing to reconcile it against.
  last_contacted_at TEXT,
  met               TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}`;

// The trash pair the lifecycle rung ALTERs on (below), spelled as column
// definitions so the rebuild can create them in one statement. ALTER TABLE ADD
// COLUMN appends, so this order is also the on-disk order a baseline vault has.
const PEOPLE_PROFILE_LIFECYCLE_COLUMNS = `
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)`;

export const PEOPLE_DDL = `
CREATE TABLE people_profile (${PEOPLE_PROFILE_COLUMNS}
) STRICT;

CREATE TABLE people_important_date (
  date_id     TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  label       TEXT NOT NULL,
  -- Recurs annually: stored as MM-DD, the year is meaningless to a birthday.
  month_day   TEXT NOT NULL CHECK (length(month_day) = 5),
  reminder_on INTEGER NOT NULL CHECK (reminder_on IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash pair + guard (issue #441 A4).
  deleted_at  TEXT,
  purge_at    TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_important_date_party ON people_important_date(party_id);

${touchUpdatedAt("people_profile", "profile_id")}
${touchUpdatedAt("people_important_date", "date_id")}
`;

// #630 P5: people become reversible without deleting their canonical party.
// The profile is the People-app membership row, so trashing it hides the person
// from that projection while preserving shared links, Tally participation, and
// every dependent fact for lossless restore.
export const PEOPLE_PROFILE_LIFECYCLE_DDL = `
ALTER TABLE people_profile ADD COLUMN deleted_at TEXT;
ALTER TABLE people_profile ADD COLUMN purge_at TEXT
  CHECK (purge_at IS NULL OR deleted_at IS NOT NULL);
CREATE INDEX people_profile_purge_idx ON people_profile(purge_at);
`;

// Issue #821, rung two: relax `cadence_days` from `> 0` to `>= 0` for vaults
// that ALREADY EXIST. Editing the baseline text above only reaches vaults
// created after the edit — `migrate()` applies rungs past `PRAGMA
// user_version`, so a file stamped v1 keeps the CHECK it was born with, and
// `people.set_cadence {cadence_days: 0}` would pass both JSON schemas and then
// throw at SQLite. SQLite cannot alter a CHECK in place, so this is the
// standard table rebuild (SQLite docs, "Making Other Kinds Of Table Schema
// Changes"): create the replacement, copy every column, drop the old table,
// rename, then restore the index and the touch trigger the drop took with it.
//
// The rebuild is written against the CURRENT full shape (profile columns +
// trash pair), so it is correct in both directions: it is what upgrades a v1
// file, and it is a faithful no-op re-creation on a fresh file that just ran
// the baseline rung and already has `>= 0`.
//
// Foreign keys: SQLite's 12-step procedure wants `foreign_keys=off` around the
// rebuild, but that pragma is a NO-OP inside a transaction and every rung runs
// inside one (see `migrate()`). `defer_foreign_keys` is the in-transaction
// equivalent SQLite documents for exactly this: constraint enforcement moves to
// COMMIT, so the intermediate DROP/RENAME cannot trip a check, and any real
// violation still aborts the rung's COMMIT (which rolls the whole rung back)
// rather than being waved through. It resets itself at the end of the
// transaction, so nothing leaks into the opened handle. Nothing currently
// REFERENCES people_profile, so the drop has no children to orphan; the
// table's own FK to core_party is re-declared verbatim and the copied rows
// point at the same parents.
export const PEOPLE_PROFILE_CADENCE_FLOOR_DDL = `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE people_profile_new (${PEOPLE_PROFILE_COLUMNS},
${PEOPLE_PROFILE_LIFECYCLE_COLUMNS}
) STRICT;
INSERT INTO people_profile_new
  (profile_id, party_id, role, avatar_color, cadence_days, last_contacted_at,
   met, created_at, updated_at, deleted_at, purge_at)
SELECT
  profile_id, party_id, role, avatar_color, cadence_days, last_contacted_at,
  met, created_at, updated_at, deleted_at, purge_at
FROM people_profile;
DROP TABLE people_profile;
ALTER TABLE people_profile_new RENAME TO people_profile;
CREATE INDEX people_profile_purge_idx ON people_profile(purge_at);
${touchUpdatedAt("people_profile", "profile_id")}
`;
