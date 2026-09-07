/*
 * THE WAVE 7 EXIT CRITERION (#996, R10): every live subscription of the
 * generated year-3 vault converges under the predicate across all three
 * outputs.
 *
 * THE CORPUS IS THE GENERATED VAULT, NOT THE FROZEN GOLDEN. The frozen
 * `issue-929` corpus proves the SCHEMA and has never carried a share —
 * `share_subscription` 0 rows, `share_authority` 1 and that one a device — so
 * a convergence assertion over it would assert nothing. The live grants are
 * `seedYear3Vault`'s: `grantees` × `person/media.asset view` plus
 * `granteeCircles` × `circle/tally.group edit`, and this fixture is the
 * spike's seeding promoted out of a scratchpad script.
 *
 * CONVERGENCE, stated as three properties per subscription:
 *   1. the first pass ENTERS exactly the member set — nothing more, nothing
 *      less, and no derived row among them;
 *   2. the second pass, with nothing moved in between, is EMPTY on all three
 *      outputs (this is what "converges" means — a transport that re-sends a
 *      standing closure has not converged, it has merely delivered);
 *   3. after a real edit to one member, the pass is ONE update and no enter
 *      and no leave.
 */

import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import {
  seedYear3Vault,
  YEAR3_DISTRIBUTIONS,
} from "@centraid/test-kit/year3-vault";

import type { VaultDb } from "../db.js";
import { replicaLogState } from "../replica/log.js";
import { sealAad, sealValue } from "../schema/sealed.js";
import {
  SHARE_DERIVED_TABLES,
  shareClosureMembers,
} from "./closure-members.js";
import { commitShareClosureDiff, diffShareClosure } from "./closure-outputs.js";
import type { ShareableItemType } from "./closure.js";
import { closeOpenVaults, household, inCommit } from "./placement-fixture.js";
import { readShareClosure } from "./read-closure.js";

/**
 * A year-3 vault at a size a unit test can afford. The distributions are
 * PROPORTIONS and needle placements, so the grant shapes hold at any size —
 * what is being asserted here is the closure predicate over every KIND of live
 * subscription the corpus declares, not a volume.
 */
const COUNTS = {
  parties: 40,
  photos: 24,
  conversations: 2,
  turnsPerConversation: 2,
  distributions: {
    ...YEAR3_DISTRIBUTIONS,
    notes: 20,
    automations: 4,
    grantees: 6,
    receiptDays: 5,
  },
};

interface LiveGrant {
  authorityId: string;
  subjectType: ShareableItemType;
  subjectId: string;
}

function seeded(): { origin: VaultDb; grants: LiveGrant[] } {
  const { origin } = household();
  seedYear3Vault(
    {
      vault: origin.vault as unknown as DatabaseSync,
      sealCell: (entity, column, rowId, plaintext) =>
        sealValue(
          origin.sealKey,
          sealAad(entity.replace(".", "_"), column, rowId),
          plaintext
        ),
    },
    COUNTS
  );
  const grants = (
    origin.vault
      .prepare(
        `SELECT authority_id, subject_type, subject_id FROM share_authority
          WHERE revoked_at IS NULL AND decision = 'granted'
            AND subject_type IN ('media.asset','tally.group')
          ORDER BY authority_id`
      )
      .all() as unknown as {
      authority_id: string;
      subject_type: string;
      subject_id: string;
    }[]
  ).map((row) => ({
    authorityId: row.authority_id,
    subjectType: row.subject_type as ShareableItemType,
    subjectId: row.subject_id,
  }));
  return { origin, grants };
}

function membersOf(origin: VaultDb, grant: LiveGrant) {
  return shareClosureMembers(
    origin.vault,
    readShareClosure(origin.vault, {
      originVaultId: "vault-priya",
      itemType: grant.subjectType,
      itemIds: [grant.subjectId],
      crossOwner: true,
    })
  );
}

describe("wave 7 convergence", () => {
  afterEach(closeOpenVaults);

  test("every live subscription of the year-3 vault converges under the predicate", () => {
    const { origin, grants } = seeded();
    expect(grants).toHaveLength(
      COUNTS.distributions.grantees + COUNTS.distributions.granteeCircles
    );
    const kinds = new Set(grants.map((grant) => grant.subjectType));
    expect([...kinds].toSorted()).toStrictEqual(["media.asset", "tally.group"]);

    for (const grant of grants) {
      const members = membersOf(origin, grant);
      expect(members.size, grant.authorityId).toBeGreaterThan(0);
      for (const member of members.values())
        expect(SHARE_DERIVED_TABLES, grant.authorityId).not.toContain(
          member.table
        );

      // 1. The first pass enters exactly the member set.
      const first = diffShareClosure(origin.vault, {
        authorityId: grant.authorityId,
        members,
      });
      expect(first.enter, grant.authorityId).toHaveLength(members.size);
      expect(first.update, grant.authorityId).toStrictEqual([]);
      expect(first.leave, grant.authorityId).toStrictEqual([]);
      commitShareClosureDiff(origin.vault, first, members);

      // 2. With nothing moved, the next pass asks the audience for nothing.
      const second = diffShareClosure(origin.vault, {
        authorityId: grant.authorityId,
        members: membersOf(origin, grant),
        since: first.cursor,
      });
      expect(
        [second.enter.length, second.update.length, second.leave.length],
        grant.authorityId
      ).toStrictEqual([0, 0, 0]);
    }
  });

  test("an edit to one member of one grant is one update, and reaches only that grant", () => {
    const { origin, grants } = seeded();
    const settled = new Map<string, { epoch: string; seq: number }>();
    for (const grant of grants) {
      const members = membersOf(origin, grant);
      const outputs = diffShareClosure(origin.vault, {
        authorityId: grant.authorityId,
        members,
      });
      commitShareClosureDiff(origin.vault, outputs, members);
      settled.set(grant.authorityId, outputs.cursor);
    }

    const edited = grants.find((grant) => grant.subjectType === "media.asset")!;
    inCommit(origin, () =>
      origin.vault
        .prepare("UPDATE media_asset SET title = ? WHERE asset_id = ?")
        .run("Retitled by the owner", edited.subjectId)
    );

    const updates = new Map<string, string[]>();
    for (const grant of grants) {
      const outputs = diffShareClosure(origin.vault, {
        authorityId: grant.authorityId,
        members: membersOf(origin, grant),
        since: settled.get(grant.authorityId)!,
      });
      expect(outputs.enter, grant.authorityId).toStrictEqual([]);
      expect(outputs.leave, grant.authorityId).toStrictEqual([]);
      // ONE for the edited grant, though the edit wrote two log rows (the write
      // and the `touch_updated_at` bump); NONE for every other grant, which is
      // the half that says an update reaches only the closures that claim it.
      updates.set(
        grant.authorityId,
        outputs.update.map((row) => row.table)
      );
    }
    expect(
      Object.fromEntries(updates),
      "one grant sees the edit; the rest see nothing"
    ).toStrictEqual(
      Object.fromEntries(
        grants.map((grant) => [
          grant.authorityId,
          grant.authorityId === edited.authorityId ? ["media_asset"] : [],
        ])
      )
    );
    expect(replicaLogState(origin.vault).watermark.seq).toBeGreaterThan(0);
  });
});
