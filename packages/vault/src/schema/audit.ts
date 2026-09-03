export const RETENTION_WINDOWS = {
  audit: { days: 365, duty: "journal-archive" },
  ledger: { days: 90, duty: "ledger-archive" },
} as const;

export const AUDIT_BAND_TABLES: readonly string[] = [
  "audit_archive_pass",
  "access_provenance",
  "agent_command_invocation",
  "access_receipt",
  "agent_invocation_check",
  "agent_evidence",
  "agent_explanation",
  "audit_archive_manifest",
];

export const AUDIT_APPEND_ONLY_TABLES: readonly string[] = [
  "access_provenance",
  "access_receipt",
  "agent_invocation_check",
  "agent_evidence",
  "agent_explanation",
];

export const AUDIT_DDL = `
-- The archive pass's door. Empty except inside the archival transaction,
-- which inserts one row, deletes the rows it has sealed, and removes it again
-- before COMMIT. A real table rather than a TEMP one so the triggers below can
-- always resolve it.
CREATE TABLE audit_archive_pass (
  active INTEGER PRIMARY KEY CHECK (active = 1)
) STRICT;

CREATE TABLE access_provenance (
  prov_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_activity TEXT NOT NULL,
  agent_kind    TEXT NOT NULL CHECK (agent_kind IN ('owner','app','ai_agent','import')),
  agent_id      TEXT NOT NULL,
  used_json     TEXT CHECK (used_json IS NULL OR json_valid(used_json)),
  occurred_at   TEXT NOT NULL,
  prev_prov_id  TEXT REFERENCES access_provenance(prov_id),
  signature     TEXT
) STRICT;
CREATE INDEX idx_provenance_entity ON access_provenance(entity_type, entity_id);
CREATE INDEX idx_provenance_prev_prov ON access_provenance(prev_prov_id);
-- The stream is read by TIME far more often than by entity (#883), and the
-- entity and chain indexes leave every such read a full scan.
CREATE INDEX idx_provenance_occurred_at ON access_provenance(occurred_at);

CREATE TABLE agent_command_invocation (
  invocation_id TEXT PRIMARY KEY,
  -- Pointers into the MODEL half stay VALUE columns, not keys: an audit row
  -- outlives its subject by design, and a foreign key would either block the
  -- member's purge or quietly rewrite the evidence (#916).
  command_id    TEXT NOT NULL, -- → agent.command
  caller_id     TEXT NOT NULL, -- → access.agent / access.app / access.device
  grant_id      TEXT,          -- → access.grant; NULL for owner-direct
  input_json    TEXT NOT NULL CHECK (json_valid(input_json)),
  status        TEXT NOT NULL CHECK (status IN ('proposed','checked','executed','failed','rolled_back')),
  requested_at  TEXT NOT NULL,
  executed_at   TEXT,
  receipt_id    TEXT REFERENCES access_receipt(receipt_id)
) STRICT;
CREATE INDEX idx_command_invocation_receipt ON agent_command_invocation(receipt_id);

CREATE TABLE access_receipt (
  receipt_id         TEXT PRIMARY KEY,
  grant_id           TEXT, -- → access.grant; NULL for owner-direct
  invocation_id      TEXT REFERENCES agent_command_invocation(invocation_id),
  action             TEXT NOT NULL,
  object_type        TEXT NOT NULL,
  object_id          TEXT,
  purpose_concept_id TEXT, -- → core.concept
  decision           TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  occurred_at        TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  -- CHAIN ORDER, SAID OUT LOUD (#916, R13 / review 5.4). The hash chain's head
  -- was found with \`ORDER BY receipt_id DESC\`, which is correct only because
  -- receipt ids happen to be UUIDv7 and therefore happen to sort by time — an
  -- accident of the id scheme holding up the integrity of the chain. \`seq\` is
  -- the chain position itself: monotonic per file, assigned when the receipt
  -- is written. Nullable, because an evidence stream is never rewritten and
  -- rows written before it existed have none; a reader falls back to id order
  -- while it is NULL.
  seq                INTEGER
) STRICT;
CREATE INDEX idx_receipt_invocation ON access_receipt(invocation_id);
CREATE UNIQUE INDEX idx_receipt_seq ON access_receipt(seq) WHERE seq IS NOT NULL;

CREATE TABLE agent_invocation_check (
  check_id      TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  phase         TEXT NOT NULL CHECK (phase IN ('pre','post')),
  predicate     TEXT NOT NULL,
  passed        INTEGER NOT NULL CHECK (passed IN (0,1)),
  observed_json TEXT CHECK (observed_json IS NULL OR json_valid(observed_json)),
  checked_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_invocation_check_invocation ON agent_invocation_check(invocation_id);

CREATE TABLE agent_evidence (
  evidence_id   TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  claim         TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_id       TEXT REFERENCES access_provenance(prov_id),
  weight        REAL CHECK (weight BETWEEN 0 AND 1)
) STRICT;
CREATE INDEX idx_evidence_invocation ON agent_evidence(invocation_id);
CREATE INDEX idx_evidence_prov ON agent_evidence(prov_id);

CREATE TABLE agent_explanation (
  explanation_id TEXT PRIMARY KEY,
  invocation_id  TEXT NOT NULL UNIQUE REFERENCES agent_command_invocation(invocation_id),
  audience       TEXT NOT NULL CHECK (audience IN ('owner','auditor')),
  summary        TEXT NOT NULL,
  generated_at   TEXT NOT NULL
) STRICT;

-- Audit segment archival (issue #367 §E2): rows past the active window are
-- sealed into a content-addressed segment (journal-archive.ts) written to
-- the vault's blob CAS, and this manifest row is the ONLY thing that stays
-- in the live file for them afterward — audit-chain verifiability without
-- keeping every row forever. chain_hash folds prev_manifest_id's own
-- chain_hash into this row's, so verifying the newest manifest transitively
-- attests every earlier archival run has not been reordered or dropped.
-- Manifests are themselves append-only (never updated, never archived) —
-- the archival trail is small by construction (one row per run, not per
-- archived audit row).
CREATE TABLE audit_archive_manifest (
  manifest_id      TEXT PRIMARY KEY,
  -- 'provenance' (access_provenance) or 'invocation_cluster' (the mutually
  -- FK-linked agent_command_invocation + access_receipt +
  -- agent_invocation_check + agent_evidence + agent_explanation rows for a
  -- batch of invocations old enough, receipt included, to seal together —
  -- see journal-archive.ts for why these archive as one unit).
  stream           TEXT NOT NULL CHECK (stream IN ('provenance', 'invocation_cluster')),
  from_id          TEXT,
  to_id            TEXT,
  from_time        TEXT NOT NULL,
  to_time          TEXT NOT NULL,
  row_count        INTEGER NOT NULL CHECK (row_count > 0),
  segment_sha256   TEXT NOT NULL CHECK (length(segment_sha256) = 64),
  segment_bytes    INTEGER NOT NULL CHECK (segment_bytes >= 0),
  prev_manifest_id TEXT REFERENCES audit_archive_manifest(manifest_id),
  chain_hash       TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_archive_manifest_stream_time ON audit_archive_manifest(stream, to_time);
CREATE INDEX idx_archive_manifest_prev_manifest ON audit_archive_manifest(prev_manifest_id);
CREATE TRIGGER access_provenance_append_only_u
BEFORE UPDATE ON access_provenance
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_provenance is append-only: an audit row is never rewritten');
END;
CREATE TRIGGER access_provenance_append_only_d
BEFORE DELETE ON access_provenance
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_provenance is append-only: rows leave only through the archive pass');
END;
CREATE TRIGGER access_receipt_append_only_u
BEFORE UPDATE ON access_receipt
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_receipt is append-only: an audit row is never rewritten');
END;
CREATE TRIGGER access_receipt_append_only_d
BEFORE DELETE ON access_receipt
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_receipt is append-only: rows leave only through the archive pass');
END;
CREATE TRIGGER agent_invocation_check_append_only_u
BEFORE UPDATE ON agent_invocation_check
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_invocation_check is append-only: an audit row is never rewritten');
END;
CREATE TRIGGER agent_invocation_check_append_only_d
BEFORE DELETE ON agent_invocation_check
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_invocation_check is append-only: rows leave only through the archive pass');
END;
CREATE TRIGGER agent_evidence_append_only_u
BEFORE UPDATE ON agent_evidence
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_evidence is append-only: an audit row is never rewritten');
END;
CREATE TRIGGER agent_evidence_append_only_d
BEFORE DELETE ON agent_evidence
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_evidence is append-only: rows leave only through the archive pass');
END;
CREATE TRIGGER agent_explanation_append_only_u
BEFORE UPDATE ON agent_explanation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_explanation is append-only: an audit row is never rewritten');
END;
CREATE TRIGGER agent_explanation_append_only_d
BEFORE DELETE ON agent_explanation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_explanation is append-only: rows leave only through the archive pass');
END;
-- \`agent_command_invocation\` is the one audit table with a LIFECYCLE: a row is
-- written 'proposed', reaches 'checked', and is settled 'executed' or 'failed'
-- with its receipt. So it refuses DELETE like the rest, and refuses any UPDATE
-- that touches the facts of the ASK — which is the half an audit is for. The
-- settlement columns (status, executed_at, receipt_id) are the only ones a
-- writer may move, and only forwards.
CREATE TRIGGER agent_command_invocation_append_only_u
BEFORE UPDATE OF invocation_id, command_id, caller_id, grant_id, input_json,
                 requested_at
ON agent_command_invocation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_command_invocation is append-only in what was asked: only status, executed_at and receipt_id settle');
END;
CREATE TRIGGER agent_command_invocation_append_only_d
BEFORE DELETE ON agent_command_invocation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_command_invocation is append-only: rows leave only through the archive pass');
END;
`;
