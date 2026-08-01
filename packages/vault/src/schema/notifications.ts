// Notices are durable, vault-owned projections behind the Notifications
// surface. Decisions deliberately remain in their canonical
// outbox/consent/agent tables; this table contains only informational notices
// that do not ask the owner for a decision (#647).

export const NOTIFICATIONS_NOTICE_DDL = `
CREATE TABLE IF NOT EXISTS notifications_notice (
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

CREATE INDEX IF NOT EXISTS notifications_notice_active_idx
  ON notifications_notice(archived_at, last_at DESC);
CREATE INDEX IF NOT EXISTS notifications_notice_retention_idx
  ON notifications_notice(last_at);
`;

/**
 * The surface formerly called "Inbox" is **Notifications** (#665), and the
 * table came with it: `inbox_notice` → `notifications_notice`. The rename is
 * part of the pre-release composed base. A fresh file never has `inbox_notice`,
 * while a recreated dev vault starts with the new rebuildable projection.
 */
export const RENAME_INBOX_NOTICE_DDL = `
DROP INDEX IF EXISTS inbox_notice_active_idx;
DROP INDEX IF EXISTS inbox_notice_retention_idx;
DROP TABLE IF EXISTS inbox_notice;
${NOTIFICATIONS_NOTICE_DDL}`;
