import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import {
  bindPartyToVault,
  revokePartyVaultBinding,
} from "../share/party-vault-binding.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import { channelForParty } from "./channel.js";

function pendingInvitation(
  db: DatabaseSync,
  partyId: string,
  memberVaultId: string | null,
  now: string
): void {
  db.prepare(
    `INSERT INTO share_commons_invitation
       (invitation_id, grant_id, steward_vault_id, member_vault_id,
        member_party_id, capability, container_type, container_id,
        current_size_bytes, max_size_bytes, claim_token_hash, status,
        created_at, answered_at)
     VALUES (?, ?, 'vault-steward', ?, ?, 'read', 'docs.folder', ?, 0, NULL,
             NULL, 'pending', ?, NULL)`
  ).run(uuidv7(), uuidv7(), memberVaultId, partyId, uuidv7(), now);
}

describe("grant/channel", () => {
  afterEach(closeOpenVaults);

  test("a person this vault has never reached has no channel at all", () => {
    const { origin } = household();
    expect(channelForParty(origin.vault, uuidv7())).toBeNull();
  });

  test("a live binding is a live channel naming the peer vault", () => {
    const { origin } = household();
    const now = nowIso();
    const partyId = uuidv7();
    expect(
      bindPartyToVault(origin.vault, {
        partyId,
        vaultId: "vault-tomas",
        linkedAt: now,
        displayName: "Tomas",
      })
    ).toBe("bound");

    expect(channelForParty(origin.vault, partyId)).toStrictEqual({
      partyId,
      state: "live",
      vaultId: "vault-tomas",
      linkedAt: now,
    });
  });

  test("binding a peer makes them a PERSON the People roster can see", () => {
    const { origin } = household();
    const partyId = uuidv7();
    bindPartyToVault(origin.vault, {
      partyId,
      vaultId: "vault-tomas",
      linkedAt: nowIso(),
      displayName: "Tomas",
    });

    expect({
      ...origin.vault
        .prepare(
          `SELECT cadence_days, deleted_at FROM people_profile WHERE party_id = ?`
        )
        .get(partyId),
    }).toStrictEqual({ cadence_days: 0, deleted_at: null });
  });

  test("a revoked binding severs the channel rather than erasing it", () => {
    const { origin } = household();
    const now = nowIso();
    const partyId = uuidv7();
    bindPartyToVault(origin.vault, {
      partyId,
      vaultId: "vault-tomas",
      linkedAt: now,
      displayName: "Tomas",
    });
    expect(
      revokePartyVaultBinding(origin.vault, {
        partyId,
        vaultId: "vault-tomas",
        revokedAt: "2033-01-01T00:00:00.000Z",
      })
    ).toBe("revoked");

    expect(channelForParty(origin.vault, partyId)).toStrictEqual({
      partyId,
      state: "severed",
      vaultId: "vault-tomas",
      linkedAt: now,
      revokedAt: "2033-01-01T00:00:00.000Z",
    });
  });

  test("a pending invitation does not resurrect a severed channel", () => {
    const { origin } = household();
    const now = nowIso();
    const partyId = uuidv7();
    bindPartyToVault(origin.vault, {
      partyId,
      vaultId: "vault-uma",
      linkedAt: now,
      displayName: "Uma",
    });
    revokePartyVaultBinding(origin.vault, {
      partyId,
      vaultId: "vault-uma",
      revokedAt: "2033-02-02T00:00:00.000Z",
    });
    pendingInvitation(origin.vault, partyId, "vault-uma-new", now);

    expect(channelForParty(origin.vault, partyId)).toStrictEqual({
      partyId,
      state: "severed",
      vaultId: "vault-uma",
      linkedAt: now,
      revokedAt: "2033-02-02T00:00:00.000Z",
    });
  });

  test("an invitation addressed by party alone is still no channel", () => {
    const { origin } = household();
    const now = nowIso();
    const partyId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Vik', 'Vik', ?, ?)`
      )
      .run(partyId, now, now);
    pendingInvitation(origin.vault, partyId, null, now);

    expect(channelForParty(origin.vault, partyId)).toBeNull();
  });

  test("a live binding is the channel, invitation or no invitation", () => {
    const { origin } = household();
    const now = nowIso();
    const partyId = uuidv7();
    bindPartyToVault(origin.vault, {
      partyId,
      vaultId: "vault-wren",
      linkedAt: now,
      displayName: "Wren",
    });
    pendingInvitation(origin.vault, partyId, "vault-wren", now);

    expect(channelForParty(origin.vault, partyId)?.state).toBe("live");
  });
});
