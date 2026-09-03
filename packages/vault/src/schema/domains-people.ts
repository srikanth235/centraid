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
// (gateway/duties.ts) is what finally purges. #630 gives people_profile the
// same lifecycle in its forward migration: trashing hides the person without
// deleting the canonical party, so restore stays lossless for 30 days. Once
// `purge_at` lapses the sweep erases the party, tags, and channels too
// (#864) — the copy is "Erased after 30 days."
//
// All tables STRICT; PKs are TEXT UUIDv7; money is fixed-scale INTEGER minor
// units; timestamps are TEXT ISO-8601 UTC — the core spine's conventions.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

const PEOPLE_PROFILE_COLUMNS = `
  profile_id        TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  role              TEXT,
  -- The owner's short name for this person (#883, ruling O-contact): the
  -- retired \`social.contact_card\` held it, and reachability moved to
  -- \`social.contact_channel\` while the display facts landed here.
  nickname          TEXT,
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
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash (#630 P5): trashing the profile hides the person from the People
  -- projection while the canonical party, its links and its Tally
  -- participation stay, so restore is lossless until the sweep purges.
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (profile_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE`;

export const PEOPLE_DDL = `
CREATE TABLE people_profile (${PEOPLE_PROFILE_COLUMNS}
) STRICT;
CREATE INDEX people_profile_purge_idx ON people_profile(purge_at);

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
  purge_at    TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (date_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_important_date_party ON people_important_date(party_id);
CREATE INDEX IF NOT EXISTS people_important_date_purge_idx
  ON people_important_date(purge_at) WHERE purge_at IS NOT NULL;

${touchUpdatedAt("people_profile", "profile_id")}
${touchUpdatedAt("people_important_date", "date_id")}
`;
