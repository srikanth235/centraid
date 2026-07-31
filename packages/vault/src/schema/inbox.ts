// Inbox notices are durable, vault-owned projections. Decisions deliberately
// remain in their canonical outbox/consent/agent tables; this table contains
// only informational notices that do not ask the owner for a decision (#647).

export const INBOX_NOTICE_DDL = `
CREATE TABLE inbox_notice (
  notice_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  headline TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','high')),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  read_at TEXT,
  archived_at TEXT,
  UNIQUE(kind, source_ref)
) STRICT;

CREATE INDEX inbox_notice_active_idx
  ON inbox_notice(archived_at, last_at DESC);
CREATE INDEX inbox_notice_retention_idx
  ON inbox_notice(last_at);
`;
