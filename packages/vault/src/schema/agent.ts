// Agent plane DDL — schema `agent` from duaility-ontology.html §03.
// Model half (vault.db): command, capability, correction, judgment. The
// plane's central credential row — the enrolled caller itself — is the
// same species as consent_app/consent_device (an enrolled caller
// credential), so it lives as `consent_agent` beside them (schema/consent.ts)
// rather than stuttering this schema's own name here; the rest of the agent
// plane (command, capability, correction, judgment — reasoning/audit
// artifacts, not caller credentials) stays put.
// Audit half (journal.db): command_invocation, invocation_check, evidence,
// explanation — see journal.ts.

export const AGENT_DDL = `
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
CREATE INDEX IF NOT EXISTS idx_capability_command ON agent_capability(command_id);

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
CREATE INDEX IF NOT EXISTS idx_correction_corrected_by_party ON agent_correction(corrected_by_party_id);

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
CREATE INDEX IF NOT EXISTS idx_judgment_derived_from_correction ON agent_judgment(derived_from_correction_id);
`;
