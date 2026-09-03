// governance: allow-repo-hygiene file-size-limit (#865) each hardening case crosses the same two-vault peer transport; per-case files would re-boot that world per suite.

import type { ServerResponse } from "node:http";

import { describe, expect, test, vi } from "vitest";

import {
  appendCommonsOperation,
  commonsGenesisHash,
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  readCommonsGrant,
  registerTallyCommands,
  signCommonsIntent,
  STALE_CONTEXT_REASON_PREFIX,
} from "@centraid/vault";

import {
  handlePeerCommonsBlob,
  handlePeerCommonsBlobAuthorize,
  PEER_COMMONS_COMMAND_PATH,
  PEER_COMMONS_SESSION_CAP,
} from "../routes/peer-commons-route.js";
import type { PeerCommonsRouteDeps } from "../routes/peer-commons-route.js";
import type { PeerIdentity } from "../routes/peer-plane.js";
import { addKnownParty } from "./commons-b6.test-fixtures.js";
import {
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import {
  dialFrom,
  link,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("commons peer-plane hardening", () => {
  test("a read-only member cannot forge a steward-attributed command by supplying actorPartyId", async () => {
    const origin = makeSide("forge-steward");
    const member = makeSide("forge-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "forge");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const commandInput = { asset_id: photo.assetId, title: "forged" };
    const forgery = await sendPeerCommonsCommand({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      command: "media.update_asset",
      commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: origin.ownerPartyId,
        command: "media.update_asset",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: "forge-nonce",
      }),
      basedOnSequence: 0,
      intentId: "forge-nonce",
    });
    expect(forgery.state).toBe("unavailable");
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND actor_party_id = ?"
        )
        .get(grant.grantId, origin.ownerPartyId)
    ).toMatchObject({ n: 0 });

    const honest = await sendPeerCommonsCommand({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "media.update_asset",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: "honest-nonce",
      }),
      basedOnSequence: 0,
      intentId: "honest-nonce",
    });
    expect(honest).toMatchObject({
      state: "refused",
      reason: "this commons is read-only for this member",
    });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND actor_party_id = ?"
        )
        .get(grant.grantId, member.ownerPartyId)
    ).toMatchObject({ n: 1 });
  });

  test("a fully caught-up member's repeated pull is a no-op, not a scrub-and-reproject", async () => {
    const origin = makeSide("noop-steward");
    const member = makeSide("noop-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "noop");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const first = await pullPeerCommons({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      seat: member.vault,
      now,
    });
    expect(first.state).toBe("current");
    expect(
      member.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    ).toMatchObject({ n: 1 });

    const second = await pullPeerCommons({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      seat: member.vault,
      now,
    });
    expect(second.state).toBe("noop");
    expect(
      member.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    ).toMatchObject({ n: 1 });
  });

  test("a steward whose history rewound parks the pull with a named fault instead of scrubbing the seat", async () => {
    const origin = makeSide("rewind-steward");
    const member = makeSide("rewind-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "rewind");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const appended = appendCommonsOperation({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: member.ownerPartyId,
      kind: "member_joined",
      input: { partyId: member.ownerPartyId },
      outcome: "executed",
      now,
    });
    const pull = () =>
      pullPeerCommons({
        dial: dialFrom(member, origin),
        route: routeFrom(member, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: grant.grantId,
        seat: member.vault,
        now,
      });
    await expect(pull()).resolves.toMatchObject({ state: "current" });

    origin.vault.vault
      .prepare(
        "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence = ?"
      )
      .run(grant.grantId, appended);
    origin.vault.vault
      .prepare(
        `UPDATE share_circle_grant
            SET last_sequence = ?, chain_head_sequence = ?, chain_head_hash = ?
          WHERE grant_id = ?`
      )
      .run(
        appended - 1,
        appended - 1,
        commonsGenesisHash(grant.grantId),
        grant.grantId
      );
    appendCommonsOperation({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      kind: "member_joined",
      input: { partyId: origin.ownerPartyId },
      outcome: "executed",
      now,
    });

    await expect(pull()).resolves.toMatchObject({
      state: "parked",
      fault: "history-diverged",
      steward: { presence: "parked", fault: "history-diverged" },
    });
    expect(
      member.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    ).toMatchObject({ n: 1 });
  });

  test("a remote member's stale-context is classified using the wire-carried based_on_sequence", async () => {
    const origin = makeSide("relay-based-on-sequence-steward");
    const member = makeSide("relay-based-on-sequence-member");
    await link(origin, member);
    const now = new Date().toISOString();
    addKnownParty(origin, member, now);
    registerTallyCommands(origin.gateway);
    const created = origin.gateway.invoke(origin.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Relay household",
        icon: "📡",
        member_ids: [member.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    const seats = () =>
      commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      });
    const splits = [
      { party_id: origin.ownerPartyId, share_minor: 450 },
      { party_id: member.ownerPartyId, share_minor: 450 },
    ];
    expect(
      executeCommonsCommand({
        steward: origin.vault,
        gateway: origin.gateway,
        credential: origin.ownerCredential,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        actorPartyId: origin.ownerPartyId,
        command: "tally.add_expense",
        commandInput: {
          group_id: groupId,
          description: "Ferry",
          amount_minor: 900,
          paid_by: origin.ownerPartyId,
          category: "travel",
          splits,
        },
        intentId: "relay-add",
        invocationId: "relay-add",
        seats: seats(),
        now,
      }).decision.accepted
    ).toBe(true);
    const expenseId = (
      origin.vault.vault
        .prepare(
          "SELECT expense_id FROM tally_expense WHERE group_id = ? AND description = 'Ferry'"
        )
        .get(groupId) as { expense_id: string }
    ).expense_id;
    expect(
      executeCommonsCommand({
        steward: origin.vault,
        gateway: origin.gateway,
        credential: origin.ownerCredential,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        actorPartyId: origin.ownerPartyId,
        command: "tally.edit_expense",
        commandInput: {
          expense_id: expenseId,
          description: "Ferry (updated)",
          amount_minor: 900,
          paid_by: origin.ownerPartyId,
          category: "travel",
          splits,
        },
        intentId: "relay-edit",
        invocationId: "relay-edit",
        seats: seats(),
        now,
      }).decision.accepted
    ).toBe(true);

    const sendMember = (
      description: string,
      basedOnSequence: number,
      intentId: string
    ) => {
      const commandInput = {
        expense_id: expenseId,
        description,
        amount_minor: 900,
        paid_by: member.ownerPartyId,
        category: "travel",
        splits,
      };
      return sendPeerCommonsCommand({
        dial: dialFrom(member, origin),
        route: routeFrom(member, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: grant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "tally.edit_expense",
        commandInput,
        memberSignature: signCommonsIntent(member.vault.identitySeed, {
          grantId: grant.grantId,
          actorPartyId: member.ownerPartyId,
          command: "tally.edit_expense",
          commandInput,
          memberVaultId: member.vaultId,
          nonce: intentId,
        }),
        basedOnSequence,
        intentId,
      });
    };

    const stale = await sendMember(
      "Ferry (member, stale)",
      0,
      "relay-stale-edit"
    );
    expect(stale.state).toBe("refused");
    expect(stale.state === "refused" ? stale.reason : undefined).toStrictEqual(
      expect.stringContaining(STALE_CONTEXT_REASON_PREFIX)
    );
    expect(
      origin.vault.vault
        .prepare("SELECT description FROM tally_expense WHERE expense_id = ?")
        .get(expenseId)
    ).toMatchObject({ description: "Ferry (updated)" });

    const fresh = await sendMember(
      "Ferry (member, fresh)",
      readCommonsGrant(origin.vault.vault, grant.grantId).lastSequence,
      "relay-fresh-edit"
    );
    expect(fresh.state).toBe("executed");
    expect(
      origin.vault.vault
        .prepare("SELECT description FROM tally_expense WHERE expense_id = ?")
        .get(expenseId)
    ).toMatchObject({ description: "Ferry (member, fresh)" });
  });

  test("a wire payload missing based_on_sequence is a hard refusal, not a default", async () => {
    const origin = makeSide("relay-missing-based-on-sequence-steward");
    const member = makeSide("relay-missing-based-on-sequence-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "missing-based-on-sequence");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const commandInput = { asset_id: photo.assetId, title: "no baseline" };
    const dial = dialFrom(member, origin);
    const route = routeFrom(member, origin);
    const bodyWithoutBasedOnSequence = {
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      input: commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "media.update_asset",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: "missing-based-on-sequence",
      }),
      intentId: "missing-based-on-sequence",
    };
    const response = await dial.request({
      endpointTicket: dial.endpointTicketFor(
        route.endpointId,
        route.relayHints
      ),
      method: "POST",
      target: PEER_COMMONS_COMMAND_PATH,
      body: bodyWithoutBasedOnSequence,
    });
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ state: "not_found" });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
  });

  test("a malformed signature nonce is refused on the wire, not surfaced as a 500", async () => {
    const origin = makeSide("nonce-steward");
    const member = makeSide("nonce-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "nonce-grammar");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const dial = dialFrom(member, origin);
    const route = routeFrom(member, origin);
    const response = await dial.request({
      endpointTicket: dial.endpointTicketFor(
        route.endpointId,
        route.relayHints
      ),
      method: "POST",
      target: PEER_COMMONS_COMMAND_PATH,
      body: {
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: grant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "media.update_asset",
        input: { asset_id: photo.assetId, title: "bad nonce" },
        memberSignature: {
          memberVaultId: member.vaultId,
          nonce: { forged: "not-a-string" },
          signature: "AAAA",
        },
        basedOnSequence: 0,
        intentId: "malformed-nonce",
      },
    });
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ state: "not_found" });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
  });

  test("transfer sessions evict oldest-first past the retention cap", async () => {
    const origin = makeSide("retention-steward");
    const member = makeSide("retention-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "retention");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const identity: PeerIdentity = {
      endpointId: "ep-retention",
      linked: true,
      linkFor: () => undefined,
      linkForPair: (localVaultId, peerVaultId) =>
        localVaultId === origin.vaultId && peerVaultId === member.vaultId
          ? {
              linkId: "link-retention",
              localVaultId: origin.vaultId,
              peerVaultId: member.vaultId,
              peerPublicKey: member.publicKey,
              peerLabel: "retention-member",
              myLabel: "retention-steward",
              route: {
                endpointId: "ep-retention",
                relayHints: [],
                assertedAt: 1,
              },
              permissions: {},
            }
          : undefined,
    };
    const deps: PeerCommonsRouteDeps = {
      vaultFor: (vaultId) =>
        vaultId === origin.vaultId ? origin.vault : undefined,
      gatewayFor: () => undefined,
      credentialFor: () => undefined,
    };
    const callRoute = (
      handler: (
        res: ServerResponse,
        peer: PeerIdentity,
        query: URLSearchParams,
        deps: PeerCommonsRouteDeps
      ) => true,
      query: URLSearchParams
    ): { status: number; json: Record<string, unknown> } => {
      let statusCode = 0;
      let body = "";
      const res = {
        setHeader: () => undefined,
        end(value?: string | Buffer) {
          if (value) body += value.toString();
        },
        get statusCode() {
          return statusCode;
        },
        set statusCode(value: number) {
          statusCode = value;
        },
      } as unknown as ServerResponse;
      handler(res, identity, query, deps);
      return { status: statusCode, json: JSON.parse(body) };
    };
    const authorize = () =>
      callRoute(
        handlePeerCommonsBlobAuthorize,
        new URLSearchParams({
          stewardVaultId: origin.vaultId,
          memberVaultId: member.vaultId,
          grantId: grant.grantId,
        })
      );
    const chunkWith = (token: string) =>
      callRoute(
        handlePeerCommonsBlob,
        new URLSearchParams({
          stewardVaultId: origin.vaultId,
          memberVaultId: member.vaultId,
          grantId: grant.grantId,
          sha256: photo.sha256,
          token,
          offset: "0",
          length: String(photo.bytes.length),
        })
      );

    const first = authorize();
    expect(first.json).toMatchObject({ state: "authorized" });
    const oldestToken = first.json.token as string;

    expect(chunkWith(oldestToken).status).toBe(200);

    for (let opened = 1; opened <= PEER_COMMONS_SESSION_CAP; opened += 1)
      expect(authorize().status).toBe(200);
    expect(chunkWith(oldestToken).status).toBe(404);
    const newest = authorize();
    expect(newest.json).toMatchObject({ state: "authorized" });
    expect(chunkWith(newest.json.token as string).status).toBe(200);
  });
});
