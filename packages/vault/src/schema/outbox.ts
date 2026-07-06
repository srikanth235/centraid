// The outbox (issue #306 decision 3): every external write is an ARTIFACT,
// not an approval. An automation or connector STAGES the rendered thing
// itself — recipient/subject/body, an event payload, an API call — as an
// inert row; the owner decides on the thing, not on "automation X requests
// permission to invoke command Y"; the broker-side executor performs the
// drain toward pinned hosts with injected credentials (the `allowWrites`
// lane that connector fires never get).
//
// One primitive, three jobs: the external-write consent surface, the
// standing-grant mint point (#294 decision 4's concrete answer), and the
// offline-outbox seam the single-gateway star topology needs anyway.
//
// `outbox_grant` is the standing "always allow" rule — scoped
// `(actor, verb, target)`, minted lazily from a concrete item instead of
// configured abstractly up front. A grant-matched item skips the pending
// pause but still drains through the same executor and lands in the review
// feed, receipted like everything else.
//
// `request_json` carries `{{connection:…}}` placeholders, never tokens —
// injection happens executor-side toward the connection's `allowed_hosts`
// pin (issue #304 invariants, unchanged).
export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox_grant (
  grant_id   TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL,
  verb       TEXT NOT NULL,
  target     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_grant_rule
  ON outbox_grant(actor_id, verb, target) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS outbox_item (
  item_id       TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  actor_id      TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('owner','app','ai_agent')),
  verb          TEXT NOT NULL,
  target        TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  request_json  TEXT NOT NULL CHECK (json_valid(request_json)),
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','sent','discarded','failed')),
  grant_id      TEXT REFERENCES outbox_grant(grant_id),
  staged_at     TEXT NOT NULL,
  decided_at    TEXT,
  drained_at    TEXT,
  result_json   TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  note          TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outbox_item_status ON outbox_item(status, staged_at);
`;
