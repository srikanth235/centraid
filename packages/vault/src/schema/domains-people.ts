// Personal-CRM DDL — schema `people`. The "keep in touch" surface: a curated
// set of the people the owner cares about, each a canonical core.party
// (kind='person') enriched with a 1:1 people_profile carrying the CRM-only
// facts the party spine doesn't model — the role line, the avatar hue, the
// keep-in-touch cadence, when they were last reached, and how they were met.
// Cross-domain facts do not get re-imported at table grain (issue #450):
// interactions are core_activity + annotation, tasks are schedule_task,
// relationships are core_link, debts are tally_obligation, and owner journal
// entries are knowledge_note, and gift ideas are typed schedule tasks linked
// to their recipient. The People band keeps only the two genuine CRM rows:
// profile and important dates.
//
// The pieces that already have a home in the ontology are NOT re-invented
// here (issue #274's rule): notes are knowledge.annotation on the party,
// favorites are the flags-scheme star on the party, and the owner files people
// into `lists` — SKOS concepts in the owner's `lists` scheme with membership
// one core.tag per person, the exact mechanism Docs folders use. These were
// called "circles" until issue #441 A2.4: that name collided with
// social_circle (the AUDIENCE mechanism shares and Tally groups target), two
// unrelated things named identically. People's classification is renamed to
// "lists" end-to-end; social_circle keeps "circle". Journal entries are the
// one owner-level (not per-person) row, so they carry the owner party directly.
//
// Trash (issue #441 A4): every owner-authored CONTENT row carries the uniform
// soft-delete pair `deleted_at` / `purge_at` with the CHECK guard
// (`purge_at IS NULL OR deleted_at IS NOT NULL`), matching Docs/Photos/Locker —
// so a delete here is a reversible grace-window trash, and the lifecycle sweep
// (gateway/duties.ts) is what finally purges and cleans the row's polymorphic
// references. people_profile is deliberately EXCLUDED: it is not content but a
// 1:1 identity decoration on the party (role/cadence/hue), whose lifecycle is
// the party's — removing a CRM contact is deleting the party, not trashing a
// profile row, so it needs no independent grace window.
//
// All tables STRICT; PKs are TEXT UUIDv7; money is fixed-scale INTEGER minor
// units; timestamps are TEXT ISO-8601 UTC — the core spine's conventions.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from './updated-at.js';

export const PEOPLE_DDL = `
CREATE TABLE people_profile (
  profile_id        TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  role              TEXT,
  avatar_color      TEXT,
  cadence_days      INTEGER NOT NULL CHECK (cadence_days > 0),
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
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
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

${touchUpdatedAt('people_profile', 'profile_id')}
${touchUpdatedAt('people_important_date', 'date_id')}
`;
