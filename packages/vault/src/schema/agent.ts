// Agent plane DDL — schema `agent` from duaility-ontology.html §03.
// Model half (vault.db): agent, command, capability, correction, judgment.
// Audit half (journal.db): command_invocation, invocation_check, evidence,
// explanation — see journal.ts.

export const AGENT_DDL = `
CREATE TABLE agent_agent (
  agent_id    TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  model_ref   TEXT NOT NULL,
  version     TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','paused','revoked'))
) STRICT;

CREATE TABLE agent_command (
  command_id          TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  owner_schema        TEXT NOT NULL,
  input_schema_json   TEXT NOT NULL CHECK (json_valid(input_schema_json)),
  output_schema_json  TEXT NOT NULL CHECK (json_valid(output_schema_json)),
  preconditions_json  TEXT NOT NULL CHECK (json_valid(preconditions_json)),
  postconditions_json TEXT NOT NULL CHECK (json_valid(postconditions_json)),
  idempotency         TEXT NOT NULL CHECK (idempotency IN ('idempotent','once','retry-safe')),
  risk                TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  ontology_version    TEXT NOT NULL
) STRICT;

CREATE TABLE agent_capability (
  capability_id         TEXT PRIMARY KEY,
  schema_name           TEXT NOT NULL,
  verb                  TEXT NOT NULL CHECK (verb IN ('discover','query','reason','act','verify','explain','learn')),
  command_id            TEXT REFERENCES agent_command(command_id),
  description           TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0,1))
) STRICT;

CREATE TABLE agent_correction (
  correction_id         TEXT PRIMARY KEY,
  invocation_id         TEXT, -- → agent.command_invocation (journal.db); gateway-enforced
  corrected_by_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_type           TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  before_json           TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json            TEXT NOT NULL CHECK (json_valid(after_json)),
  reason                TEXT,
  created_at            TEXT NOT NULL
) STRICT;

CREATE TABLE agent_judgment (
  judgment_id                TEXT PRIMARY KEY,
  derived_from_correction_id TEXT REFERENCES agent_correction(correction_id),
  subject_scope              TEXT NOT NULL,
  rule_json                  TEXT NOT NULL CHECK (json_valid(rule_json)),
  confidence                 REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  active                     INTEGER NOT NULL CHECK (active IN (0,1)),
  learned_at                 TEXT NOT NULL,
  expires_at                 TEXT
) STRICT;
`;
