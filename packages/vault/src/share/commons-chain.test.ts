// Verifiable commons history (issue #731): the op hash chain, the signed
// checkpoint digest, and the member-side parks that keep a diverged steward
// from ever scrubbing a replica.

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import {
  applyCommonsBootstrap,
  exportCommonsBootstrap,
} from "./commons-bootstrap.js";
import type { CommonsBootstrap } from "./commons-bootstrap.js";
import {
  CommonsHistoryError,
  commonsGenesisHash,
  readCommonsChainHead,
  readCommonsVerified,
} from "./commons-chain.js";
import {
  appendCommonsOperation,
  compileCommons,
  createCommonsGrant,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";
import type { Household } from "./placement-fixture.js";

const STEWARD_VAULT = "vault-priya";
const MEMBER_VAULT = "vault-family";

function addParty(
  db: Household["origin"]["vault"],
  name: string,
  now: string
): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at, ontology_version)
     VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

/** One steward + one member seat, compiled: the shape every peer sync starts
 * from. The steward's own vault id is bound, so the member can resolve the
 * signing key for checkpoint attestations. */
function commons(label: string): {
  house: Household;
  grantId: string;
  memberPartyId: string;
  assetId: string;
  now: string;
} {
  const house = household();
  const now = nowIso();
  const bob = addParty(house.origin.vault, "Bob", now);
  const photo = seedPhoto(house.origin, house.originBoot, label);
  const grant = createCommonsGrant({
    origin: house.origin.vault,
    ownerPartyId: house.originBoot.ownerPartyId,
    ownerVaultId: STEWARD_VAULT,
    ownerVault: house.origin,
    containerType: "media.asset",
    containerId: photo.assetId,
    members: [
      {
        partyId: bob,
        capability: "read+write",
        vaultId: MEMBER_VAULT,
        vault: house.audience,
      },
    ],
    now,
  });
  compileCommons({
    steward: house.origin,
    stewardVaultId: STEWARD_VAULT,
    grantId: grant.grantId,
    seats: [
      {
        partyId: house.originBoot.ownerPartyId,
        capability: "read+write",
        vaultId: STEWARD_VAULT,
        vault: house.origin,
      },
      {
        partyId: bob,
        capability: "read+write",
        vaultId: MEMBER_VAULT,
        vault: house.audience,
      },
    ],
    now,
  });
  return {
    house,
    grantId: grant.grantId,
    memberPartyId: bob,
    assetId: photo.assetId,
    now,
  };
}

function control(
  house: Household,
  grantId: string,
  partyId: string,
  now: string
): number {
  return appendCommonsOperation({
    steward: house.origin.vault,
    grantId,
    actorPartyId: partyId,
    kind: "member_joined",
    input: { partyId },
    outcome: "executed",
    now,
  });
}

function exported(house: Household, grantId: string): CommonsBootstrap {
  return exportCommonsBootstrap({
    steward: house.origin.vault,
    identitySeed: house.origin.identitySeed,
    stewardVaultId: STEWARD_VAULT,
    grantId,
    memberVaultId: MEMBER_VAULT,
  });
}

/** The named fault an apply parked with — `undefined` when it did not park. */
function parked(apply: () => void): string | undefined {
  try {
    apply();
  } catch (error) {
    return error instanceof CommonsHistoryError ? error.fault : String(error);
  }
  return undefined;
}

function assets(house: Household): number {
  return (
    house.audience.vault
      .prepare("SELECT COUNT(*) AS n FROM media_asset")
      .get() as { n: number }
  ).n;
}

describe("commons verifiable history", () => {
  afterEach(closeOpenVaults);

  test("every appended op links to its predecessor and the member records the head it verified", () => {
    const { house, grantId, memberPartyId, now } = commons("chain");
    const first = control(house, grantId, memberPartyId, now);
    const second = control(house, grantId, memberPartyId, now);
    const ops = house.origin.vault
      .prepare(
        "SELECT sequence, prev_hash, op_hash FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
      )
      .all(grantId) as {
      sequence: number;
      prev_hash: string;
      op_hash: string;
    }[];
    expect(ops.map((op) => op.sequence)).toStrictEqual([first, second]);
    // Sequence 1 links to the grant's genesis; nothing else is unlinked.
    expect(ops[0]!.prev_hash).toBe(commonsGenesisHash(grantId));
    expect(ops[1]!.prev_hash).toBe(ops[0]!.op_hash);
    expect(readCommonsChainHead(house.origin.vault, grantId)).toStrictEqual({
      sequence: second,
      hash: ops[1]!.op_hash,
    });

    const wire = exported(house, grantId);
    expect(wire.checkpoint.sequence).toBe(wire.snapshotSequence);
    applyCommonsBootstrap({ seat: house.audience, wire, now });
    expect(readCommonsVerified(house.audience.vault, grantId)).toStrictEqual({
      sequence: second,
      opHash: ops[1]!.op_hash,
    });
  });

  test("a mutated op parks the sync: the hash it carries no longer matches its own fields", () => {
    const { house, grantId, memberPartyId, now } = commons("tamper");
    control(house, grantId, memberPartyId, now);
    const wire = exported(house, grantId);
    expect(wire.tail).toHaveLength(1);
    const tampered = {
      ...wire,
      tail: [
        {
          ...wire.tail[0]!,
          input_json: JSON.stringify({ partyId: "mallory" }),
        },
      ],
    };
    expect(
      parked(() =>
        applyCommonsBootstrap({ seat: house.audience, wire: tampered, now })
      )
    ).toBe("history-diverged");
    // Parked, never scrubbed: the replica this member already held survives.
    expect(assets(house)).toBe(1);
    expect(readCommonsVerified(house.audience.vault, grantId)).toBeUndefined();
  });

  test("a snapshot whose bytes disagree with its signed digest parks without scrubbing", () => {
    const { house, grantId, now } = commons("digest");
    const wire = exported(house, grantId);
    // The signature still checks out; the closure under it does not.
    const swapped: CommonsBootstrap = {
      ...wire,
      closure: { ...wire.closure, blobs: [] },
    };
    expect(
      parked(() =>
        applyCommonsBootstrap({ seat: house.audience, wire: swapped, now })
      )
    ).toBe("digest-mismatch");
    expect(assets(house)).toBe(1);
  });

  test("a steward whose log rewound below a verified sequence parks instead of re-applying", () => {
    const { house, grantId, memberPartyId, now } = commons("rewind");
    control(house, grantId, memberPartyId, now);
    const second = control(house, grantId, memberPartyId, now);
    applyCommonsBootstrap({
      seat: house.audience,
      wire: exported(house, grantId),
      now,
    });
    const verified = readCommonsVerified(house.audience.vault, grantId);
    expect(verified?.sequence).toBe(second);

    // Restore-from-backup at the steward: sequence 2 is dropped, the chain head
    // moves back to sequence 1, and a DIFFERENT op takes the vacated slot.
    const head = house.origin.vault
      .prepare(
        "SELECT op_hash FROM share_commons_op WHERE grant_id = ? AND sequence = 1"
      )
      .get(grantId) as { op_hash: string };
    house.origin.vault
      .prepare(
        "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence = ?"
      )
      .run(grantId, second);
    house.origin.vault
      .prepare(
        `UPDATE share_circle_grant
            SET last_sequence = 1, chain_head_sequence = 1, chain_head_hash = ?
          WHERE grant_id = ?`
      )
      .run(head.op_hash, grantId);
    const forked = control(house, grantId, memberPartyId, nowIso());
    expect(forked).toBe(second);

    expect(() =>
      applyCommonsBootstrap({
        seat: house.audience,
        wire: exported(house, grantId),
        now,
      })
    ).toThrow(/rewound at sequence 2/u);
    expect(
      parked(() =>
        applyCommonsBootstrap({
          seat: house.audience,
          wire: exported(house, grantId),
          now,
        })
      )
    ).toBe("history-diverged");
    expect(assets(house)).toBe(1);
    // The verified point never moved backward to accommodate the fork.
    expect(readCommonsVerified(house.audience.vault, grantId)).toStrictEqual(
      verified
    );
  });

  test("a frame that omits the chain is a fault, not a shape to tolerate", () => {
    const { house, grantId, memberPartyId, now } = commons("required");
    control(house, grantId, memberPartyId, now);
    const wire = exported(house, grantId);
    const unsigned = { ...wire } as Partial<CommonsBootstrap>;
    delete unsigned.checkpoint;
    expect(
      parked(() =>
        applyCommonsBootstrap({
          seat: house.audience,
          wire: unsigned as CommonsBootstrap,
          now,
        })
      )
    ).toBe("history-diverged");
    const unhashed = {
      ...wire,
      tail: wire.tail.map((row) => {
        const copy = { ...row };
        delete copy["op_hash"];
        return copy;
      }),
    };
    expect(
      parked(() =>
        applyCommonsBootstrap({ seat: house.audience, wire: unhashed, now })
      )
    ).toBe("history-diverged");
    expect(assets(house)).toBe(1);
  });
});
