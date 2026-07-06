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
//
// The graph joins (issue #310 S2): `target` stays the wire-level address the
// standing-grant key needs, but it is not an entity — so an item also
// carries typed refs the graph can walk. `(subject_type, subject_id)` is
// the canonical row the write is ABOUT (the invoice being sent, the event
// being created); `recipient_party_id` is the resolved destination person.
// And a drain is not the end of the story: a sent message-shaped artifact
// PUBLISHES into the social spine (thread + message + body content item) —
// `published_message_id` binds the item to the canonical fact it became, so
// the owner's own outbound acts are first-class rows, not JSON stranded in
// result_json until a provider sync re-imports them.
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
  item_id              TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sync_connection(connection_id),
  actor_id             TEXT NOT NULL,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('owner','app','ai_agent')),
  verb                 TEXT NOT NULL,
  target               TEXT NOT NULL,
  subject_type         TEXT,
  subject_id           TEXT,
  recipient_party_id   TEXT REFERENCES core_party(party_id),
  artifact_json        TEXT NOT NULL CHECK (json_valid(artifact_json)),
  request_json         TEXT NOT NULL CHECK (json_valid(request_json)),
  status               TEXT NOT NULL CHECK (status IN ('pending','approved','sent','discarded','failed')),
  grant_id             TEXT REFERENCES outbox_grant(grant_id),
  staged_at            TEXT NOT NULL,
  decided_at           TEXT,
  drained_at           TEXT,
  result_json          TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  published_message_id TEXT REFERENCES social_message(message_id),
  note                 TEXT,
  CHECK ((subject_type IS NULL) = (subject_id IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outbox_item_status ON outbox_item(status, staged_at);
`;
