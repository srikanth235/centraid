// Access plane DDL — schema `access` (#916, owner decision D4).
//
// WHY THE NAME. This plane was called `consent` for four releases and had
// stopped being about consent: `access_app` is an install register,
// `access_device` an enrolment register, `access_app_ext` an app's own table
// declarations. What the plane actually decides is ACCESS — who may read
// what, for how long, under which purpose — and a member's standing ANSWER
// has lived in `share_authority` since #883. A plane whose name describes a
// third of its rows makes every scope string a small lie, so the physical
// prefix, the logical schema, the Atlas label and the scope strings the
// bootstrap seeds all moved together.
//
// `access_grant` became `access_grant`, not `access_access_grant`:
// the old table name carried the plane because the plane was called something
// else, and with the prefix saying `access` the qualifier is already there.
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
  installed_at TEXT NOT NULL
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

CREATE TABLE access_grant (
  grant_id            TEXT PRIMARY KEY,
  app_id              TEXT REFERENCES access_app(app_id),
  grantee_party_id    TEXT REFERENCES core_party(party_id),
  purpose_concept_id  TEXT NOT NULL REFERENCES core_concept(concept_id),
  granted_by_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  granted_at          TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('active','expired','revoked'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_access_grant_app ON access_grant(app_id);
CREATE INDEX IF NOT EXISTS idx_access_grant_grantee_party ON access_grant(grantee_party_id);
CREATE INDEX IF NOT EXISTS idx_access_grant_purpose_concept ON access_grant(purpose_concept_id);
CREATE INDEX IF NOT EXISTS idx_access_grant_granted_by_party ON access_grant(granted_by_party_id);

-- ONE ENCODING OF "WHICH ENTITY" (#916, R10 / review 7.1). The vault carried
-- four: a (schema_name, table_name) pair here, an (applies_schema,
-- applies_table) pair on the policy, a dotted string on
-- share_authority.subject_type, and a dotted string in every polymorphic
-- pointer. Two of them had to be re-joined into a dotted name by hand at every
-- read, and \`gateway/duties.ts\` was GUESSING which half of the pair it held.
-- Both pairs are now the one dotted form the rest of the vault already speaks.
--
-- A bare pack name (\`core\`) means the whole pack; a dotted name
-- (\`core.event\`) means that entity. That is the same two-level shape the pair
-- expressed, in the spelling grants, receipts, links and pointers all use.
CREATE TABLE access_grant_scope (
  scope_id        TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL REFERENCES access_grant(grant_id),
  entity          TEXT NOT NULL,
  verbs           TEXT NOT NULL CHECK (verbs IN ('read','read+act','act','reveal')),
  row_filter_json TEXT CHECK (row_filter_json IS NULL OR json_valid(row_filter_json)),
  field_mask_json TEXT CHECK (field_mask_json IS NULL OR json_valid(field_mask_json)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_grant_scope_grant ON access_grant_scope(grant_id);

CREATE TABLE access_policy (
  policy_id      TEXT PRIMARY KEY,
  -- 'residency' left the vocabulary under ruling ONT-06: nothing read it, and
  -- a local-first vault has one residency — this device.
  kind           TEXT NOT NULL CHECK (kind IN ('retention','purpose','minimization')),
  entity         TEXT NOT NULL,
  rule_json      TEXT NOT NULL CHECK (json_valid(rule_json)),
  retention_days INTEGER CHECK (retention_days > 0),
  effective_from TEXT NOT NULL,
  priority       INTEGER NOT NULL
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

// #308 A3/A4: access memory for the install-grant top-up.
//
// `access_scope_tombstone` — the owner's "no", made durable. #306's top-up
// diffed declared scopes against ACTIVE grants only, so an owner-revoked
// scope was silently re-minted on the next mount/sync/publish. A revocation
// now writes one tombstone per scope triple; the top-up (and the widening
// request below) skip tombstoned triples, and only an explicit owner
// re-approval clears them. Uninstall clears the app's tombstones — a
// reinstall is a fresh answer.
//
// `access_scope_request` — a manifest that widens BEYOND the last owner answer
// parks here as a blocking item instead of auto-granting: agents author their
// own manifests, so "install was the answer" must not be bypassable by the
// very actor the answer contains. One open request per (plane, app);
// re-publishes replace the open request's scope set.
export const ACCESS_INSTALL_MEMORY_DDL = `
CREATE TABLE IF NOT EXISTS access_scope_tombstone (
  tombstone_id     TEXT PRIMARY KEY,
  app_id           TEXT REFERENCES access_app(app_id),
  grantee_party_id TEXT REFERENCES core_party(party_id),
  -- The same dotted encoding \`access_grant_scope.entity\` carries (R10): a
  -- tombstone is the exact scope triple that was withdrawn, so it has to be
  -- comparable to the scope it forbids without either side being re-joined.
  entity           TEXT NOT NULL,
  verbs            TEXT NOT NULL CHECK (verbs IN ('read','read+act','act','reveal')),
  row_filter_json  TEXT CHECK (row_filter_json IS NULL OR json_valid(row_filter_json)),
  field_mask_json  TEXT CHECK (field_mask_json IS NULL OR json_valid(field_mask_json)),
  revoked_at       TEXT NOT NULL,
  CHECK (app_id IS NOT NULL OR grantee_party_id IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_scope_tombstone_app ON access_scope_tombstone(app_id);
CREATE INDEX IF NOT EXISTS idx_scope_tombstone_party ON access_scope_tombstone(grantee_party_id);

CREATE TABLE IF NOT EXISTS access_scope_request (
  request_id   TEXT PRIMARY KEY,
  plane        TEXT NOT NULL CHECK (plane IN ('app','agent')),
  app_id       TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  scopes_json  TEXT NOT NULL CHECK (json_valid(scopes_json)),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decision     TEXT CHECK (decision IN ('approved','denied'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_request_open
  ON access_scope_request(plane, app_id) WHERE decided_at IS NULL;
`;
