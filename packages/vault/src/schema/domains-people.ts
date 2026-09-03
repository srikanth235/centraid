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
