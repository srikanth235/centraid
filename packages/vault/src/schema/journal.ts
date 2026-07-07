// journal.db DDL — the append-only audit stream, split out of vault.db per
// §03 "Physical layout — two files": it grows orders of magnitude faster than
// the model, never rolls back domain writes, and keeping it out of the vault
// keeps the sovereign asset permanently small.
//
// Tables here reference vault.db rows (grant_id, command_id, agent_id…) but
// cross-file FKs cannot be engine-enforced — the gateway validates them (§10
// S4). Append-only is a contract enforced by the gateway (no UPDATE path),
// not a trigger.
//
// The FILE carries a second band this module does not own: the runtime's
// conversation ledger (conversations, turns, items, attachments,
// automation_state, run_summary — the old standalone transcripts.db, folded
// in because both bands share the append-heavy, derived-growth profile that
// keeps vault.db small). That band is declared in app-engine
// (`CONVERSATION_LEDGER_DDL`), created idempotently on open, MUTABLE (turns
// finish, CASCADE deletes), and never stamps `PRAGMA user_version` — the
// version ladder below governs the audit band alone. The append-only
// contract in this header applies only to the audit tables.

export const JOURNAL_DDL = `
CREATE TABLE consent_provenance (
  prov_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_activity TEXT NOT NULL,
  agent_kind    TEXT NOT NULL CHECK (agent_kind IN ('owner','app','ai_agent','import')),
  agent_id      TEXT NOT NULL,
  used_json     TEXT CHECK (used_json IS NULL OR json_valid(used_json)),
  occurred_at   TEXT NOT NULL,
  prev_prov_id  TEXT REFERENCES consent_provenance(prov_id),
  signature     TEXT
) STRICT;
CREATE INDEX idx_provenance_entity ON consent_provenance(entity_type, entity_id);

CREATE TABLE agent_command_invocation (
  invocation_id TEXT PRIMARY KEY,
  command_id    TEXT NOT NULL, -- → agent.command (vault.db); gateway-enforced
  agent_id      TEXT NOT NULL, -- → agent.agent / consent.app / consent.device; gateway-enforced
  grant_id      TEXT,          -- → consent.access_grant (vault.db); NULL for owner-direct
  input_json    TEXT NOT NULL CHECK (json_valid(input_json)),
  status        TEXT NOT NULL CHECK (status IN ('proposed','checked','executed','failed','rolled_back')),
  requested_at  TEXT NOT NULL,
  executed_at   TEXT,
  receipt_id    TEXT REFERENCES consent_receipt(receipt_id)
) STRICT;

CREATE TABLE consent_receipt (
  receipt_id         TEXT PRIMARY KEY,
  grant_id           TEXT, -- → consent.access_grant (vault.db); NULL for owner-direct
  invocation_id      TEXT REFERENCES agent_command_invocation(invocation_id),
  action             TEXT NOT NULL,
  object_type        TEXT NOT NULL,
  object_id          TEXT,
  purpose_concept_id TEXT, -- → core.concept (vault.db); gateway-enforced
  decision           TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  occurred_at        TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE TABLE agent_invocation_check (
  check_id      TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  phase         TEXT NOT NULL CHECK (phase IN ('pre','post')),
  predicate     TEXT NOT NULL,
  passed        INTEGER NOT NULL CHECK (passed IN (0,1)),
  observed_json TEXT CHECK (observed_json IS NULL OR json_valid(observed_json)),
  checked_at    TEXT NOT NULL
) STRICT;

CREATE TABLE agent_evidence (
  evidence_id   TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  claim         TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_id       TEXT REFERENCES consent_provenance(prov_id),
  weight        REAL CHECK (weight BETWEEN 0 AND 1)
) STRICT;

CREATE TABLE agent_explanation (
  explanation_id TEXT PRIMARY KEY,
  invocation_id  TEXT NOT NULL UNIQUE REFERENCES agent_command_invocation(invocation_id),
  audience       TEXT NOT NULL CHECK (audience IN ('owner','auditor')),
  summary        TEXT NOT NULL,
  generated_at   TEXT NOT NULL
) STRICT;
`;
