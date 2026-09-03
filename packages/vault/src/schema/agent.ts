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
  verb                  TEXT NOT NULL CHECK (verb IN ('discover','query','reason','act','verify','explain')),
  command_id            TEXT REFERENCES agent_command(command_id),
  description           TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0,1))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_capability_command ON agent_capability(command_id);

`;
