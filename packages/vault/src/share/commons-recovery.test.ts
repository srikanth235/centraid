// Replica-export recovery (#731): a member re-founds a commons whose steward
// is gone. The claims under test are the ceremony's guarantees — no data loss,
// no fabricated consent, idempotent retry, and two named refusals.

import { afterEach, describe, expect, test } from "vitest";

import { nowIso } from "../ids.js";
import { commonsSeats } from "./commons-lifecycle.js";
import {
  readCommonsRecoveryLineage,
  recoverCommonsFromReplica,
} from "./commons-recovery.js";
import {
  compileCommons,
  createCommonsGrant,
  readCommonsGrant,
} from "./commons.js";
import type { CommonsGrantRecord } from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";
import type { Household } from "./placement-fixture.js";

/** Priya stewards a shared photo; the Family vault holds a full replica. */
function shared(): { home: Household; grant: CommonsGrantRecord; now: string } {
  const home = household();
  const now = nowIso();
  const photo = seedPhoto(home.origin, home.originBoot, "recovery");
  const grant = createCommonsGrant({
    origin: home.origin.vault,
    ownerPartyId: home.originBoot.ownerPartyId,
    ownerVaultId: "vault-priya",
    ownerVault: home.origin,
    containerType: "media.asset",
    containerId: photo.assetId,
    members: [
      {
        partyId: home.audienceBoot.ownerPartyId,
        capability: "read+write",
        vaultId: "vault-family",
        vault: home.audience,
      },
    ],
    now,
  });
  compileCommons({
    steward: home.origin,
    stewardVaultId: "vault-priya",
    grantId: grant.grantId,
    seats: commonsSeats({
      steward: home.origin.vault,
      grantId: grant.grantId,
      stewardVaultId: "vault-priya",
      vaultFor: (vaultId) =>
        vaultId === "vault-priya"
          ? home.origin
          : vaultId === "vault-family"
            ? home.audience
            : undefined,
    }),
    now,
  });
  return { home, grant, now };
}

function park(home: Household, grantId: string, now: string): void {
  home.audience.vault
    .prepare(
      `INSERT INTO share_commons_steward_contact
         (grant_id, member_vault_id, last_outcome, fault, faulted_at, attempts)
       VALUES (?, 'vault-family', 'parked', 'history-diverged', ?, 1)`
    )
    .run(grantId, now);
}

describe("commons replica-export recovery", () => {
  afterEach(closeOpenVaults);

  test("a member re-founds the group at sequence 0 without losing the old grant", () => {
    const { home, grant, now } = shared();
    const opsBefore = home.audience.vault
      .prepare("SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?")
      .get(grant.grantId) as { n: number };

    const result = recoverCommonsFromReplica({
      seat: home.audience,
      localVaultId: "vault-family",
      grantId: grant.grantId,
      now,
    });

    expect(result.state).toBe("recovered");
    if (result.state !== "recovered") return;
    expect(result.replayed).toBe(false);
    expect(result.grantId).not.toBe(grant.grantId);
    const successor = readCommonsGrant(home.audience.vault, result.grantId);
    // Stewarded by the recovering vault, fresh genesis chain, sequence 0.
    expect(successor.stewardPartyId).toBe(home.audienceBoot.ownerPartyId);
    expect(successor.lastSequence).toBe(0);
    expect(successor.containerType).toBe(grant.containerType);
    // The superseded grant keeps every row it had; only its sync stops.
    const old = readCommonsGrant(home.audience.vault, grant.grantId);
    expect(old.revokedAt).toBe(now);
    expect(
      home.audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toStrictEqual(opsBefore);
    // Lineage explains where the successor came from.
    const lineage = readCommonsRecoveryLineage(
      home.audience.vault,
      grant.grantId
    );
    expect(lineage?.oldStewardPartyId).toBe(home.originBoot.ownerPartyId);
    expect(lineage?.sourceSequence).toBe(grant.lastSequence);
    expect(lineage?.sourceChainHeadHash).toHaveLength(64);
    expect(lineage?.sourceStateDigest).toHaveLength(64);
  });

  test("every other seat is invited, never joined on its behalf", () => {
    const { home, grant, now } = shared();
    const result = recoverCommonsFromReplica({
      seat: home.audience,
      localVaultId: "vault-family",
      grantId: grant.grantId,
      now,
    });
    expect(result.state).toBe("recovered");
    if (result.state !== "recovered") return;
    expect(result.invitedPartyIds).toStrictEqual([
      home.originBoot.ownerPartyId,
    ]);
    const states = home.audience.vault
      .prepare(
        `SELECT party_id, status FROM share_commons_member_state
          WHERE grant_id = ? ORDER BY party_id`
      )
      .all(result.grantId) as { party_id: string; status: string }[];
    const byParty = new Map(states.map((row) => [row.party_id, row.status]));
    expect(byParty.get(home.audienceBoot.ownerPartyId)).toBe("current");
    expect(byParty.get(home.originBoot.ownerPartyId)).toBe("invited");
    // Capabilities carry over from the superseded roster.
    const capability = home.audience.vault
      .prepare(
        `SELECT capability FROM social_circle_member
          WHERE circle_id = ? AND party_id = ?`
      )
      .get(result.circleId, home.originBoot.ownerPartyId) as {
      capability: string;
    };
    expect(capability.capability).toBe("read+write");
  });

  test("retry is idempotent: one successor, one supersession row", () => {
    const { home, grant, now } = shared();
    const first = recoverCommonsFromReplica({
      seat: home.audience,
      localVaultId: "vault-family",
      grantId: grant.grantId,
      now,
    });
    const second = recoverCommonsFromReplica({
      seat: home.audience,
      localVaultId: "vault-family",
      grantId: grant.grantId,
      now: nowIso(),
    });
    expect(first.state).toBe("recovered");
    expect(second.state).toBe("recovered");
    if (first.state !== "recovered" || second.state !== "recovered") return;
    expect(second.grantId).toBe(first.grantId);
    expect(second.circleId).toBe(first.circleId);
    expect(second.replayed).toBe(true);
    // The lineage keeps the FIRST attempt's timestamp — a retry re-reports it
    // rather than rewriting history.
    expect(second.lineage.recoveredAt).toBe(now);
    expect({
      ...home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM share_commons_supersession")
        .get(),
    }).toStrictEqual({ n: 1 });
    expect({
      ...home.audience.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_circle_grant
            WHERE plane = 'commons' AND revoked_at IS NULL`
        )
        .get(),
    }).toStrictEqual({ n: 1 });
  });

  test("refuses while the seat is parked on a divergence fault", () => {
    const { home, grant, now } = shared();
    park(home, grant.grantId, now);
    const result = recoverCommonsFromReplica({
      seat: home.audience,
      localVaultId: "vault-family",
      grantId: grant.grantId,
      now,
    });
    expect(result).toStrictEqual({
      state: "refused",
      reason: "parked-on-fault",
    });
    // Nothing was founded and nothing was superseded.
    expect({
      ...home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM share_commons_supersession")
        .get(),
    }).toStrictEqual({ n: 0 });
    expect(
      readCommonsGrant(home.audience.vault, grant.grantId).revokedAt
    ).toBeUndefined();
  });

  test("refuses at the steward's own vault", () => {
    const { home, grant, now } = shared();
    const result = recoverCommonsFromReplica({
      seat: home.origin,
      localVaultId: "vault-priya",
      grantId: grant.grantId,
      now,
    });
    expect(result).toStrictEqual({
      state: "refused",
      reason: "already-steward",
    });
  });
});
