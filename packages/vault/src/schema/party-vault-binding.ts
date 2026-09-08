// WHERE A PERSON IS REACHABLE (#731, kept through #929). The binding is what
// turns a party on the owner's graph into a vault a share can be delivered to;
// it outlived the commons rail because the answer it gives — "this person is
// reachable at that vault" — is the one every subscription needs.
//
// `social_circle_member.capability` rides here for the same reason: a circle
// says who, and the capability says what they may do inside it, which the
// subscription's `edit` answer is derived from.

export const SHARE_PARTY_BINDING_DDL = `
ALTER TABLE social_circle_member ADD COLUMN capability TEXT NOT NULL DEFAULT 'read'
  CHECK (capability IN ('read','read+write'));

CREATE TABLE share_party_vault_binding (
  binding_id TEXT PRIMARY KEY,
  party_id   TEXT NOT NULL REFERENCES core_party(party_id),
  vault_id   TEXT NOT NULL,
  vault_public_key TEXT,
  linked_at  TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (party_id, vault_id)
) STRICT;
CREATE UNIQUE INDEX share_party_vault_binding_live_party
  ON share_party_vault_binding(party_id) WHERE revoked_at IS NULL;

-- A BINDING IS ABOUT SOMEONE ELSE (#916, R9 / review 6.5). The table says
-- "this person is reachable at that vault", and nothing stopped it recording
-- the member's own party at the member's own vault — a self-binding that makes
-- the member their own peer, so a share to them would be delivered by the
-- transport to the file it came from. SQLite cannot express "different from a
-- value in another table" in a CHECK, so it is a pair of triggers.
CREATE TRIGGER share_party_vault_binding_not_self_ai
BEFORE INSERT ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;
CREATE TRIGGER share_party_vault_binding_not_self_au
BEFORE UPDATE OF party_id, vault_id ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;
`;
