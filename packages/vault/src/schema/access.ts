// Access plane DDL — schema `access` (#916, owner decision D4).
//
// WHY THE NAME. This plane was called `consent` for four releases and had
// stopped being about consent: `access_app` is an install register,
// `access_device` an enrolment register, `access_app_ext` an app's own table
// declarations. What the plane actually decides is ACCESS — who may read
// what and for how long — and a member's standing ANSWER
// has lived in `share_authority` since #883. A plane whose name describes a
// third of its rows makes every scope string a small lie, so the physical
// prefix, the logical schema, the Atlas label and the scope strings the
// bootstrap seeds all moved together.
//
// WHAT THE PLANE NO LONGER HOLDS (#928). `access_grant`, `access_grant_scope`,
// `access_policy` and the two install-memory tables are gone: a first-party
// app is not a principal, so its reach is its build-time entity manifest, and
// an automation's standing answer is a `share_authority` row like every other
// principal's. What stays here is REGISTERS — who is installed, who is
// enrolled, which device is which.
//
// The plane's evidence stream moved with it: `access_provenance` and
// `access_receipt` are the audit band's tables (`audit.ts`), in the same file
// and under the same one name. Only the MODEL half is here.
export const ACCESS_DDL = `
CREATE TABLE access_app (
  app_id       TEXT PRIMARY KEY,
  -- The host-side enrollment key (Centraid app id) — lookup identity,
  -- never shown to the owner directly. display_name (nullable, falls
  -- back to a humanized name — see host.ts) is what an approval surface
  -- renders (issue: parked-invocation trust legibility).
  name         TEXT NOT NULL,
  display_name TEXT,
  -- The owner's per-vault rename (issue #434). Distinct from display_name:
  -- display_name self-heals to the app manifest/pretty name on every
  -- re-enrollment, so it cannot hold a durable override. label is never
  -- touched by the self-heal — the app listing prefers it over the manifest
  -- name. NULL means no override (fall back to the manifest name). Bundled
  -- app code is read-only, so a rename cannot rewrite app.json; it lands here.
  label        TEXT,
  publisher    TEXT,
  manifest_uri TEXT,
  signing_key  TEXT UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('active','revoked')),
  -- One value, because an app reaches a vault by being installed and has had
  -- no other door since #799 (#916, ruling ONT-07).
  origin       TEXT NOT NULL CHECK (origin IN ('installed')),
  risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low','medium','high')),
  installed_at TEXT NOT NULL,
  -- WHEN THE INSTALL ENDED (#928). An app is not a principal, so there is no
  -- grant whose \`revoked_at\` an app could be told about; the register itself
  -- records it, and that timestamp is what the bridge hands back so an app
  -- can say "you removed my access on <date>" rather than guessing.
  revoked_at   TEXT,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;

CREATE TABLE access_agent (
  agent_id       TEXT PRIMARY KEY,
  party_id       TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  -- Stable host-side enrollment identity (Centraid app id, or '_assistant').
  -- The owner's display label remains on core_party and may change without
  -- minting a new autonomous principal.
  enrollment_key TEXT NOT NULL UNIQUE,
  model_ref       TEXT NOT NULL,
  version         TEXT NOT NULL,
  enrolled_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','paused','revoked'))
) STRICT;

CREATE TABLE access_device (
  device_id      TEXT PRIMARY KEY,
  -- Identity here, authority next door: this says who the device IS;
  -- \`share_authority\` says what the member let it do (#883).
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  platform       TEXT,
  public_key     TEXT NOT NULL UNIQUE,
  enrolled_at    TEXT NOT NULL,
  last_seen_at   TEXT,
  sync_cursor    TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_device_owner_party ON access_device(owner_party_id);
`;
