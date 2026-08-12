// governance: allow-repo-hygiene file-size-limit (#731) the three generated properties and their real two-vault fixture are one matrix/law owner; splitting the owner would weaken one-flow-one-home accounting
import { afterEach, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { registerTallyCommands } from "../commands/tally.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  applyCommonsBootstrap,
  exportCommonsBootstrap,
} from "./commons-bootstrap.js";
import { advanceCommonsCursor, readCommonsCursor } from "./commons-cursor.js";
import { upsertCommonsMember } from "./commons-lifecycle.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  appendCommonsOperation,
  authorizeCommonsCommand,
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
} from "./commons.js";
import type { CommonsMemberInput } from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

const NOW = "2031-02-03T04:05:06.000Z";
const INTERLEAVING_RUNS = 20;
const CONVERGENCE_RUNS = 10;
// Each generated example opens real encrypted vaults. The focused file runs in
// roughly 22 seconds, while the affected suite deliberately contends with five
// other packages doing the same SQLite/crypto work; keep the property workload
// unchanged and give that bounded, measured contention room to finish.
const PROPERTY_TIMEOUT_MS = 180_000;

type GrantKey = "a" | "b";

const interleavedGrantOperations = fc
  .array(fc.constantFrom<GrantKey>("a", "b"), {
    minLength: 2,
    maxLength: 18,
  })
  .filter((schedule) => schedule.includes("a") && schedule.includes("b"))
  .chain((schedule) =>
    fc
      .array(fc.integer({ min: 0, max: schedule.length - 1 }), {
        minLength: 1,
        maxLength: schedule.length * 2,
      })
      .map((deliveries) => ({ deliveries, schedule }))
  );

const cursorGapCommands = fc
  .array(
    fc.integer({ min: 1, max: 5_000 }).map((amount) => amount * 2),
    {
      minLength: 1,
      maxLength: 6,
    }
  )
  .chain((amounts) =>
    fc
      .integer({ min: 0, max: amounts.length - 1 })
      .map((deliveredCount) => ({ amounts, deliveredCount }))
  );

const downgradeSchedule = fc
  .integer({ min: 1, max: 10 })
  .chain((commandCount) =>
    fc
      .integer({ min: 0, max: commandCount })
      .map((commandsBeforeDowngrade) => ({
        commandCount,
        commandsBeforeDowngrade,
      }))
  );

interface TallyCommonsFixture {
  origin: VaultDb;
  audience: VaultDb;
  originPartyId: string;
  memberPartyId: string;
  credential: Credential;
  gateway: ReturnType<typeof createGateway>;
  groupId: string;
  grantId: string;
  seats: CommonsMemberInput[];
}

function addAudienceOwnerAsParty(input: {
  origin: VaultDb;
  partyId: string;
  displayName: string;
}): void {
  input.origin.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
    )
    .run(input.partyId, input.displayName, input.displayName, NOW, NOW);
}

function tallyCommonsFixture(): TallyCommonsFixture {
  const { origin, originBoot, audience, audienceBoot } = household();
  addAudienceOwnerAsParty({
    origin,
    partyId: audienceBoot.ownerPartyId,
    displayName: audienceBoot.displayName,
  });
  const gateway = createGateway(origin);
  registerTallyCommands(gateway);
  const credential: Credential = {
    kind: "device",
    deviceId: originBoot.deviceId,
    deviceKey: originBoot.deviceKey,
  };
  const created = gateway.invoke(credential, {
    command: "tally.create_group",
    input: {
      name: "Generated convergence",
      icon: "🧪",
      member_ids: [audienceBoot.ownerPartyId],
    },
    purpose: "dpv:ServiceProvision",
  });
  if (created.status !== "executed")
    throw new Error(
      `could not create generated Tally group: ${created.status}`
    );
  const groupId = (created as { output: { group_id: string } }).output.group_id;
  const grant = createCommonsGrant({
    origin: origin.vault,
    ownerPartyId: originBoot.ownerPartyId,
    ownerVaultId: "vault-priya",
    ownerVault: origin,
    containerType: "tally.group",
    containerId: groupId,
    members: [
      {
        partyId: audienceBoot.ownerPartyId,
        capability: "read+write",
        vaultId: "vault-family",
        vault: audience,
      },
    ],
    now: NOW,
  });
  return {
    origin,
    audience,
    originPartyId: originBoot.ownerPartyId,
    memberPartyId: audienceBoot.ownerPartyId,
    credential,
    gateway,
    groupId,
    grantId: grant.grantId,
    seats: [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write",
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: audienceBoot.ownerPartyId,
        capability: "read+write",
        vaultId: "vault-family",
        vault: audience,
      },
    ],
  };
}

function tallyState(db: VaultDb, groupId: string): Record<string, unknown> {
  const group = db.vault
    .prepare(
      `SELECT g.group_id, g.circle_id, c.name, g.icon, g.color
         FROM tally_group g
         JOIN social_circle c ON c.circle_id = g.circle_id
        WHERE g.group_id = ?`
    )
    .get(groupId) as Record<string, unknown>;
  const expenses = db.vault
    .prepare(
      `SELECT expense_id, group_id, description, amount_minor, paid_by,
              spent_on, category, deleted_at
         FROM tally_expense WHERE group_id = ? ORDER BY expense_id`
    )
    .all(groupId) as Record<string, unknown>[];
  const splits = db.vault
    .prepare(
      `SELECT s.expense_id, s.party_id, s.share_minor
         FROM tally_expense_split s
         JOIN tally_expense e ON e.expense_id = s.expense_id
        WHERE e.group_id = ? ORDER BY s.expense_id, s.party_id`
    )
    .all(groupId) as Record<string, unknown>[];
  const members = db.vault
    .prepare(
      `SELECT m.party_id, m.capability
         FROM social_circle_member m
         JOIN tally_group g ON g.circle_id = m.circle_id
        WHERE g.group_id = ? ORDER BY m.party_id`
    )
    .all(groupId) as Record<string, unknown>[];
  return {
    group: { ...group },
    expenses: expenses.map((row) => ({ ...row })),
    splits: splits.map((row) => ({ ...row })),
    members: members.map((row) => ({ ...row })),
  };
}

describe("commons ordered-convergence property", () => {
  afterEach(closeOpenVaults);

  test(
    "[law:commons-steward-ordered-convergence] interleaved grants keep independent monotonic sequences and cursors",
    () => {
      fc.assert(
        fc.property(interleavedGrantOperations, ({ deliveries, schedule }) => {
          try {
            const { origin, originBoot, audience } = household();
            const photoA = seedPhoto(origin, originBoot, "property-a");
            const photoB = seedPhoto(origin, originBoot, "property-b");
            const grants = {
              a: createCommonsGrant({
                origin: origin.vault,
                ownerPartyId: originBoot.ownerPartyId,
                containerType: "media.asset",
                containerId: photoA.assetId,
                members: [],
                now: NOW,
              }),
              b: createCommonsGrant({
                origin: origin.vault,
                ownerPartyId: originBoot.ownerPartyId,
                containerType: "media.asset",
                containerId: photoB.assetId,
                members: [],
                now: NOW,
              }),
            };
            const expectedLast: Record<GrantKey, number> = { a: 0, b: 0 };
            const appended = schedule.map((grantKey) => {
              const sequence = appendCommonsOperation({
                steward: origin.vault,
                grantId: grants[grantKey].grantId,
                actorPartyId: originBoot.ownerPartyId,
                kind: "command",
                command: "media.update_asset",
                input: { ordinal: expectedLast[grantKey] },
                outcome: "executed",
                now: NOW,
              });
              expectedLast[grantKey] += 1;
              expect(sequence).toBe(expectedLast[grantKey]);
              return { grantKey, sequence };
            });

            const applied: Record<GrantKey, number> = { a: 0, b: 0 };
            const pending: Record<GrantKey, Set<number>> = {
              a: new Set(),
              b: new Set(),
            };
            const deliver = (operation: (typeof appended)[number]): void => {
              const grantKey = operation.grantKey;
              const before = applied[grantKey];
              const arrivedOverGap =
                operation.sequence > before + 1 &&
                !pending[grantKey].has(before + 1);
              pending[grantKey].add(operation.sequence);
              while (pending[grantKey].delete(applied[grantKey] + 1)) {
                applied[grantKey] += 1;
                advanceCommonsCursor({
                  db: audience.vault,
                  grantId: grants[grantKey].grantId,
                  memberVaultId: "vault-family",
                  sequence: applied[grantKey],
                  now: NOW,
                });
              }
              expect(
                readCommonsCursor(
                  audience.vault,
                  grants[grantKey].grantId,
                  "vault-family"
                )?.sequence ?? 0
              ).toBe(applied[grantKey]);
              expect(
                !arrivedOverGap || applied[grantKey] === before,
                `grant ${grantKey} advanced from ${before} over missing sequence ${before + 1}`
              ).toBe(true);
            };

            for (const delivery of deliveries) deliver(appended[delivery]!);
            // Catch-up may replay entries already buffered. The cursor advances
            // only when the missing next sequence arrives, then drains the
            // now-contiguous suffix in order.
            for (const operation of appended) deliver(operation);

            for (const grantKey of ["a", "b"] as const) {
              const grantId = grants[grantKey].grantId;
              expect(applied[grantKey]).toBe(expectedLast[grantKey]);
              expect(
                readCommonsCursor(audience.vault, grantId, "vault-family")
                  ?.sequence
              ).toBe(expectedLast[grantKey]);
              expect(
                origin.vault
                  .prepare(
                    "SELECT sequence FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
                  )
                  .all(grantId)
                  .map((row) => ({ ...(row as Record<string, unknown>) }))
              ).toStrictEqual(
                Array.from({ length: expectedLast[grantKey] }, (_, index) => ({
                  sequence: index + 1,
                }))
              );
            }
          } finally {
            closeOpenVaults();
          }
        }),
        { numRuns: INTERLEAVING_RUNS, seed: 731_01 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  test(
    "a real cursor gap remains unapplied until snapshot-plus-tail repairs it without from-zero replay",
    () => {
      fc.assert(
        fc.property(cursorGapCommands, ({ amounts, deliveredCount }) => {
          try {
            const fixture = tallyCommonsFixture();
            compileCommons({
              steward: fixture.origin,
              stewardVaultId: "vault-priya",
              grantId: fixture.grantId,
              seats: fixture.seats,
              now: NOW,
            });

            amounts.forEach((amount, index) => {
              const commandInput = {
                group_id: fixture.groupId,
                description: `generated-${index}-${amount}`,
                amount_minor: amount,
                paid_by: fixture.originPartyId,
                category: "food",
                splits: [
                  {
                    party_id: fixture.originPartyId,
                    share_minor: amount / 2,
                  },
                  {
                    party_id: fixture.memberPartyId,
                    share_minor: amount / 2,
                  },
                ],
              };
              const result = executeCommonsCommand({
                steward: fixture.origin,
                gateway: fixture.gateway,
                credential: fixture.credential,
                stewardVaultId: "vault-priya",
                grantId: fixture.grantId,
                actorPartyId: fixture.originPartyId,
                command: "tally.add_expense",
                commandInput,
                seats:
                  index < deliveredCount
                    ? fixture.seats
                    : fixture.seats.slice(0, 1),
                invocationId: `generated-${index}-${amount}`,
                now: NOW,
              });
              expect(result.decision).toMatchObject({
                accepted: true,
                sequence: index + 1,
              });
            });

            expect(
              readCommonsCursor(
                fixture.audience.vault,
                fixture.grantId,
                "vault-family"
              )?.sequence
            ).toBe(deliveredCount);
            expect(amounts.length - deliveredCount).toBeGreaterThan(0);
            expect(
              fixture.audience.vault
                .prepare(
                  "SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?"
                )
                .get(fixture.groupId)
            ).toMatchObject({ n: deliveredCount });
            expect(
              fixture.origin.vault
                .prepare(
                  "SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?"
                )
                .get(fixture.groupId)
            ).toMatchObject({ n: amounts.length });
            expect(
              fixture.origin.vault
                .prepare(
                  "SELECT sequence FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
                )
                .all(fixture.grantId)
                .map((row) => ({ ...(row as Record<string, unknown>) }))
            ).toStrictEqual(
              amounts.map((_, index) => ({ sequence: index + 1 }))
            );

            const wire = exportCommonsBootstrap({
              steward: fixture.origin.vault,
              identitySeed: fixture.origin.identitySeed,
              stewardVaultId: "vault-priya",
              grantId: fixture.grantId,
              memberVaultId: "vault-family",
            });
            expect(wire.currentSequence).toBe(amounts.length);
            expect(wire.snapshotSequence).toBeGreaterThanOrEqual(
              deliveredCount
            );
            applyCommonsBootstrap({
              seat: fixture.audience,
              wire,
              now: NOW,
            });
            applyCommonsBootstrap({
              seat: fixture.audience,
              wire,
              now: NOW,
            });

            expect(
              readCommonsCursor(
                fixture.audience.vault,
                fixture.grantId,
                "vault-family"
              )?.sequence
            ).toBe(amounts.length);
            expect(tallyState(fixture.audience, fixture.groupId)).toStrictEqual(
              tallyState(fixture.origin, fixture.groupId)
            );
          } finally {
            closeOpenVaults();
          }
        }),
        { numRuns: CONVERGENCE_RUNS, seed: 731_02 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  test(
    "a capability downgrade takes effect at its generated position between signed commands",
    () => {
      fc.assert(
        fc.property(
          downgradeSchedule,
          ({ commandCount, commandsBeforeDowngrade }) => {
            try {
              const fixture = tallyCommonsFixture();
              const decisions: Array<{ accepted: boolean; sequence: number }> =
                [];
              let downgradeSequence = 0;
              for (let index = 0; index <= commandCount; index += 1) {
                if (index === commandsBeforeDowngrade) {
                  downgradeSequence = upsertCommonsMember({
                    steward: fixture.origin.vault,
                    grantId: fixture.grantId,
                    actorPartyId: fixture.originPartyId,
                    member: {
                      partyId: fixture.memberPartyId,
                      capability: "read",
                      vaultId: "vault-family",
                      vault: fixture.audience,
                    },
                    now: NOW,
                  });
                }
                if (index === commandCount) break;
                const commandInput = {
                  group_id: fixture.groupId,
                  ordinal: index,
                };
                const memberSignature = signCommonsIntent(
                  fixture.audience.identitySeed,
                  {
                    grantId: fixture.grantId,
                    actorPartyId: fixture.memberPartyId,
                    command: "tally.add_expense",
                    commandInput,
                    memberVaultId: "vault-family",
                    nonce: `generated-downgrade-${index}`,
                  }
                );
                decisions.push(
                  authorizeCommonsCommand({
                    steward: fixture.origin.vault,
                    grantId: fixture.grantId,
                    actorPartyId: fixture.memberPartyId,
                    command: "tally.add_expense",
                    commandInput,
                    memberSignature,
                    now: NOW,
                  })
                );
              }

              expect(downgradeSequence).toBe(commandsBeforeDowngrade + 1);
              expect(
                decisions.map((decision) => decision.accepted)
              ).toStrictEqual(
                Array.from(
                  { length: commandCount },
                  (_, index) => index < commandsBeforeDowngrade
                )
              );
              expect(
                decisions.map((decision) => decision.sequence)
              ).toStrictEqual(
                Array.from({ length: commandCount }, (_, index) =>
                  index < commandsBeforeDowngrade ? index + 1 : index + 2
                )
              );

              const operations = fixture.origin.vault
                .prepare(
                  `SELECT sequence, kind, outcome, reason
                   FROM share_commons_op WHERE grant_id = ? ORDER BY sequence`
                )
                .all(fixture.grantId) as Record<string, unknown>[];
              expect(operations.map((row) => ({ ...row }))).toStrictEqual([
                ...Array.from(
                  { length: commandsBeforeDowngrade },
                  (_, index) => ({
                    sequence: index + 1,
                    kind: "command",
                    outcome: "executed",
                    reason: null,
                  })
                ),
                {
                  sequence: commandsBeforeDowngrade + 1,
                  kind: "capability_changed",
                  outcome: "executed",
                  reason: null,
                },
                ...Array.from(
                  { length: commandCount - commandsBeforeDowngrade },
                  (_, index) => ({
                    sequence: commandsBeforeDowngrade + index + 2,
                    kind: "command",
                    outcome: "refused",
                    reason: "this commons is read-only for this member",
                  })
                ),
              ]);
            } finally {
              closeOpenVaults();
            }
          }
        ),
        { numRuns: INTERLEAVING_RUNS, seed: 731_03 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
