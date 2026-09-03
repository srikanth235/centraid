// Regression cover for the #731 commons hardening pass (PR #735): fork guard,
// version-skew parking, no-backward-regression, the undeclared-command hole,
// nonce-collision refusal, the default size ceiling, and the compaction stall.

import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  applyCommonsBootstrap,
  exportCommonsBootstrap,
} from "./commons-bootstrap.js";
import { commonsSeats } from "./commons-lifecycle.js";
import type { CommonsMemberSignature } from "./commons-signature.js";
import {
  acknowledgeCommonsSeatCursor,
  COMMONS_MEMBER_IDENTITY_CHANGED,
  appendCommonsOperation,
  assertCommonsWithinMax,
  COMMONS_DEFAULT_MAX_SIZE_BYTES,
  commonsGrantForCommand,
  compactCommonsOperations,
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  transferCommonsSteward,
} from "./commons.js";
import type {
  CommonsCommandDecision,
  ExecuteCommonsCommandInput,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

function addParty(
  db: ReturnType<typeof household>["origin"]["vault"],
  name: string,
  now: string,
  partyId = uuidv7()
): string {
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at)
     VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?)`
  ).run(partyId, name, name, now, now);
  return partyId;
}

/** The one write rail, driven at the steward. Every case below refuses
 * structurally or replays a stored decision, so nothing is ever invoked and
 * no member vault has to be reconciled into. */
function stewardWrite(fixture: {
  origin: ReturnType<typeof household>["origin"];
  originBoot: ReturnType<typeof household>["originBoot"];
  grantId: string;
}) {
  const gateway = createGateway(fixture.origin);
  const credential: Credential = {
    kind: "device",
    deviceId: fixture.originBoot.deviceId,
    deviceKey: fixture.originBoot.deviceKey,
  };
  return (
    input: Omit<
      ExecuteCommonsCommandInput,
      | "steward"
      | "gateway"
      | "credential"
      | "stewardVaultId"
      | "grantId"
      | "seats"
    >
  ): CommonsCommandDecision =>
    executeCommonsCommand({
      ...input,
      steward: fixture.origin,
      gateway,
      credential,
      stewardVaultId: "vault-priya",
      grantId: fixture.grantId,
      seats: commonsSeats({
        steward: fixture.origin.vault,
        grantId: fixture.grantId,
        stewardVaultId: "vault-priya",
        vaultFor: () => undefined,
      }),
    }).decision;
}

describe("commons hardening", () => {
  afterEach(closeOpenVaults);

  test("fork guard: a command addressed to a vault that is no longer the steward refuses without appending", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "fork-guard");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    // Hand stewardship to Bob. Priya's vault is now an ordinary member seat.
    const successor = transferCommonsSteward({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });
    expect(successor).toBe(bob);
    const lastSequenceBefore = origin.vault
      .prepare(
        "SELECT last_sequence AS n FROM share_circle_grant WHERE grant_id = ?"
      )
      .get(grant.grantId) as { n: number };

    const gateway = createGateway(origin);
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const answer = executeCommonsCommand({
      steward: origin,
      gateway,
      credential,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      command: "media.noop",
      commandInput: { asset_id: photo.assetId },
      seats: commonsSeats({
        steward: origin.vault,
        grantId: grant.grantId,
        stewardVaultId: "vault-priya",
        vaultFor: () => undefined,
      }),
      now,
    });
    expect(answer.decision).toMatchObject({
      accepted: false,
      reason: "this vault is not the current steward for the commons",
    });
    // The abandoned log never grew: no op was appended past the transfer.
    expect(
      origin.vault
        .prepare(
          "SELECT last_sequence AS n FROM share_circle_grant WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: lastSequenceBefore.n });
  });

  test("undeclared command targeting a commons container refuses instead of a private local mutation", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "undeclared");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    // media.asset has no actable-registry entry, so the resolver must
    // still route the command to the commons rail.
    expect(
      commonsGrantForCommand(origin.vault, "media.update_asset", {
        asset_id: photo.assetId,
      })?.grantId
    ).toBe(grant.grantId);
    const gateway = createGateway(origin);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    expect(
      gateway.invoke(credential, {
        command: "media.update_asset",
        input: { asset_id: photo.assetId },
      })
    ).toMatchObject({
      status: "denied",
      reason: "command media.update_asset is not declared for media.asset",
    });
  });

  test("a re-minted member identity refuses by NAME, not as an invalid signature", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "identity");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: bob,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    const pinned = origin.vault
      .prepare(
        `SELECT vault_public_key AS key FROM share_party_vault_binding
          WHERE party_id = ? AND vault_id = ?`
      )
      .get(bob, "vault-family") as { key: string };
    expect(pinned.key).toBeTruthy();
    const write = stewardWrite({ origin, originBoot, grantId: grant.grantId });
    // The member vault lost its seed and was re-created: it links, it signs,
    // and its key is simply not the one this commons pinned.
    const decision = write({
      actorPartyId: bob,
      command: "media.update_asset",
      commandInput: { asset_id: photo.assetId },
      memberSignature: {
        memberVaultId: "vault-family",
        nonce: "re-mint",
        signature: Buffer.alloc(64).toString("base64"),
      },
      presentedVaultPublicKey: Buffer.alloc(32, 7).toString("base64"),
      now,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain(COMMONS_MEMBER_IDENTITY_CHANGED);
    expect(decision.reason).not.toContain("invalid vault signature");
    // The named fault is durable on the refusal receipt, so logs and the
    // observability read-back name the condition instead of the symptom.
    const receipt = origin.vault
      .prepare(
        `SELECT reason FROM share_commons_op
          WHERE grant_id = ? ORDER BY sequence DESC LIMIT 1`
      )
      .get(grant.grantId) as { reason: string };
    expect(receipt.reason).toContain(COMMONS_MEMBER_IDENTITY_CHANGED);
    // The named fault is a REAL distinction: with no presented key the same
    // seat falls through to the ordinary structural refusal instead.
    const unnamed = write({
      actorPartyId: bob,
      command: "media.update_asset",
      commandInput: { asset_id: photo.assetId, note: "second" },
      memberSignature: {
        memberVaultId: "vault-family",
        nonce: "no-key",
        signature: Buffer.alloc(64).toString("base64"),
      },
      now,
    });
    expect(unnamed.reason).toBe(
      "command media.update_asset is not declared for media.asset"
    );
  });

  test("a signature nonce reused for a different command refuses instead of silently replaying", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const photo = seedPhoto(origin, originBoot, "nonce");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [],
      now,
    });
    const signature: CommonsMemberSignature = {
      memberVaultId: "vault-family",
      nonce: "shared-nonce",
      signature: "unused-for-steward-actor",
    };
    const write = stewardWrite({ origin, originBoot, grantId: grant.grantId });
    const first = write({
      actorPartyId: originBoot.ownerPartyId,
      command: "media.first",
      commandInput: { asset_id: photo.assetId },
      memberSignature: signature,
      now,
    });
    // The exact same command + input replays idempotently (the stored outcome).
    const replay = write({
      actorPartyId: originBoot.ownerPartyId,
      command: "media.first",
      commandInput: { asset_id: photo.assetId },
      memberSignature: signature,
      now,
    });
    expect(replay).toStrictEqual(first);
    // A DIFFERENT command under the same nonce is a collision, not a retry.
    const collision = write({
      actorPartyId: originBoot.ownerPartyId,
      command: "media.second",
      commandInput: { asset_id: photo.assetId },
      memberSignature: signature,
      now,
    });
    expect(collision).toMatchObject({
      accepted: false,
      reason:
        "commons signature nonce was reused for a different command or input",
    });
  });

  test("assertCommonsWithinMax applies a finite default ceiling when the grant declares no maximum", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const photo = seedPhoto(origin, originBoot, "default-cap");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [],
      now,
    });
    expect(grant.maxSizeBytes).toBeUndefined();
    expect(COMMONS_DEFAULT_MAX_SIZE_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(COMMONS_DEFAULT_MAX_SIZE_BYTES)).toBe(true);
    // A small closure stays under the default; the ceiling is applied, not
    // skipped, so an unbounded grow is no longer possible.
    const size = assertCommonsWithinMax(
      origin.vault,
      "vault-priya",
      grant.grantId
    );
    expect(size).toBeLessThan(COMMONS_DEFAULT_MAX_SIZE_BYTES);
  });

  test("a version-skew bootstrap parks: it never scrubs the prior replica", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "skew");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    const seats = [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write" as const,
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: bob,
        capability: "read+write" as const,
        vaultId: "vault-family",
        vault: audience,
      },
    ];
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
    const wire = exportCommonsBootstrap({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    expect(() =>
      applyCommonsBootstrap({
        seat: audience,
        wire: {
          ...wire,
          closure: {
            ...wire.closure,
            formatVersion: 99 as unknown as typeof wire.closure.formatVersion,
          },
        },
        now,
      })
    ).toThrow(/unsupported share closure format/u);
    // The prior projection survives the skew — no empty-and-re-fail loop.
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
  });

  test("a stale frame whose head is behind the local cursor is a no-op", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "regression");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    const seats = [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write" as const,
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: bob,
        capability: "read+write" as const,
        vaultId: "vault-family",
        vault: audience,
      },
    ];
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });
    // The seat has already advanced well past this frame's head.
    acknowledgeCommonsSeatCursor({
      steward: audience.vault,
      grantId: grant.grantId,
      memberVaultId: "vault-family",
      sequence: 999,
      now,
    });
    const wire = exportCommonsBootstrap({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    expect(wire.currentSequence).toBeLessThan(999);
    applyCommonsBootstrap({ seat: audience, wire, now });
    // Neither the projection nor the cursor moved backward.
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT sequence AS n FROM share_commons_cursor WHERE grant_id = ? AND member_vault_id = ?"
        )
        .get(grant.grantId, "vault-family")
    ).toMatchObject({ n: 999 });
  });

  test("a never-synced member no longer stalls compaction forever", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "compaction");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      // Bob is a current member with a vault binding but has never bootstrapped,
      // so he owns no cursor row at all.
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    const append = () =>
      appendCommonsOperation({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: originBoot.ownerPartyId,
        kind: "command",
        command: "media.touch",
        input: { asset_id: photo.assetId },
        outcome: "executed",
        now,
      });
    // Advance the log, then move the checkpoint up to that point, then keep
    // appending so the verbose tail clears the compaction trigger.
    let checkpoint = 0;
    for (let i = 0; i < 5; i += 1) checkpoint = append();
    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET checkpoint_sequence = ? WHERE grant_id = ?"
      )
      .run(checkpoint, grant.grantId);
    for (let i = 0; i < 32; i += 1) append();

    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_cursor WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
    const pruned = compactCommonsOperations(origin.vault, grant.grantId);
    expect(pruned).toBeGreaterThan(0);
    // The pruned convenience ops are covered by the checkpoint; a too-far-behind
    // member re-bootstraps rather than pinning the tail.
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND sequence <= ?"
        )
        .get(grant.grantId, checkpoint)
    ).toMatchObject({ n: 0 });
  });
});
