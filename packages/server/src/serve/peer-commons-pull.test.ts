/*
 * Peer-rail catch-up cost (#750 invariant 7): the blob lane authorizes ONCE
 * per transfer session and streams chunks to the vault's own temp file; a
 * member on the op chain receives an increment that leaves its seat-local
 * derived rows alone; and a full bootstrap frame past the member's page
 * budget arrives as bounded pages, never one response serializing the whole
 * commons.
 */

import crypto from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  appendCommonsOperation,
  blobUriFor,
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  readCommonsGrant,
  registerMediaCommands,
  replicaInvocationKey,
} from "@centraid/vault";

import {
  PEER_COMMONS_BLOB_AUTH_PATH,
  PEER_COMMONS_BLOB_PATH,
} from "../routes/peer-commons-route.js";
import { pullPeerCommons } from "./peer-commons-client.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { dialFrom, link, makeSide } from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";

// Real vault fixtures plus a multi-mebibyte CAS transfer: cold setup under
// the concurrent pre-push gate can exceed the small unit default.
vi.setConfig({ testTimeout: 60_000 });

/** Wrap a dial so the suite can count exactly which doors were knocked. */
function countingDial(dial: PeerDial): { dial: PeerDial; targets: string[] } {
  const targets: string[] = [];
  return {
    targets,
    dial: {
      endpointTicketFor: dial.endpointTicketFor,
      request: (input) => {
        targets.push(input.target);
        return dial.request(input);
      },
    },
  };
}

function seedBigPhoto(
  side: Side,
  label: string,
  bytes: Buffer
): { assetId: string; sha256: string } {
  const original = side.vault.blobs.ingestSync(bytes);
  const now = new Date().toISOString();
  const contentId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(original.sha256),
      original.sha256,
      original.byteSize,
      `Photo ${label}`,
      side.ownerPartyId,
      now
    );
  const assetId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO media_asset
         (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id,
          place_id, camera_device_id, width, height, duration_s, exif_json,
          favorite, archived_at, deleted_at, purge_at)
       VALUES (?, ?, 'photo', ?, NULL, NULL, NULL, NULL, 800, 600, NULL, NULL, 0, NULL, NULL, NULL)`
    )
    .run(assetId, contentId, now);
  return { assetId, sha256: original.sha256 };
}

async function commonsPair(
  label: string,
  bytes: Buffer
): Promise<{
  origin: Side;
  member: Side;
  grantId: string;
  assetId: string;
  sha256: string;
}> {
  const origin = makeSide(`${label}-origin`);
  const member = makeSide(`${label}-member`);
  await link(origin, member);
  const now = new Date().toISOString();
  const photo = seedBigPhoto(origin, label, bytes);
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
  return {
    origin,
    member,
    grantId: grant.grantId,
    assetId: photo.assetId,
    sha256: photo.sha256,
  };
}

describe("peer commons pull cost (#750 invariant 7)", () => {
  test("a multi-chunk blob pull authorizes once and streams through the temp file", async () => {
    // 2.5 MiB → three 1 MiB chunk requests.
    const bytes = crypto.randomBytes(2_500_000);
    const pair = await commonsPair("blob-session", bytes);
    const counted = countingDial(dialFrom(pair.member, pair.origin));
    const store = pair.member.vault.blobs.local;
    const adopted: string[] = [];
    const adoptTempSync = store.adoptTempSync?.bind(store);
    expect(adoptTempSync).toBeDefined();
    store.adoptTempSync = (sha256, tmpPath) => {
      adopted.push(sha256);
      return adoptTempSync!(sha256, tmpPath);
    };
    const result = await pullPeerCommons({
      dial: counted.dial,
      route: {
        endpointId: pair.origin.endpointId,
        relayHints: [],
      },
      stewardVaultId: pair.origin.vaultId,
      memberVaultId: pair.member.vaultId,
      grantId: pair.grantId,
      seat: pair.member.vault,
    });
    expect(result).toMatchObject({ state: "current" });
    expect(store.getSync(pair.sha256)?.equals(bytes)).toBe(true);
    // Steward-side authorization work is bounded: ONE transfer session for
    // the whole blob, never a closure export per chunk.
    const authCalls = counted.targets.filter((target) =>
      target.startsWith(PEER_COMMONS_BLOB_AUTH_PATH)
    );
    const chunkCalls = counted.targets.filter((target) =>
      target.startsWith(PEER_COMMONS_BLOB_PATH)
    );
    expect(authCalls).toHaveLength(1);
    expect(chunkCalls).toHaveLength(3);
    for (const call of chunkCalls) expect(call).toContain("token=");
    // Member-side peak memory is one chunk: the bytes streamed through the
    // vault's promotion temp file and were adopted, not assembled in RAM.
    expect(adopted).toStrictEqual([pair.sha256]);
  });

  test("a chunk request without a transfer session is refused", async () => {
    const bytes = crypto.randomBytes(64);
    const pair = await commonsPair("blob-noauth", bytes);
    const dial = dialFrom(pair.member, pair.origin);
    const params = new URLSearchParams({
      stewardVaultId: pair.origin.vaultId,
      memberVaultId: pair.member.vaultId,
      grantId: pair.grantId,
      sha256: pair.sha256,
      offset: "0",
      length: "1024",
    });
    const bare = await dial.request({
      endpointTicket: dial.endpointTicketFor(pair.origin.endpointId, []),
      method: "GET",
      target: `${PEER_COMMONS_BLOB_PATH}?${params}`,
    });
    expect(bare.status).toBe(404);
    params.set("token", "not-a-session");
    const forged = await dial.request({
      endpointTicket: dial.endpointTicketFor(pair.origin.endpointId, []),
      method: "GET",
      target: `${PEER_COMMONS_BLOB_PATH}?${params}`,
    });
    expect(forged.status).toBe(404);
  });

  test("a member on the chain receives an increment and keeps its derived rows", async () => {
    const bytes = crypto.randomBytes(256);
    const pair = await commonsPair("increment", bytes);
    const dial = dialFrom(pair.member, pair.origin);
    const route = { endpointId: pair.origin.endpointId, relayHints: [] };
    const first = await pullPeerCommons({
      dial,
      route,
      stewardVaultId: pair.origin.vaultId,
      memberVaultId: pair.member.vaultId,
      grantId: pair.grantId,
      seat: pair.member.vault,
    });
    expect(first).toMatchObject({ state: "current" });
    // Seat-local derived state a full re-baseline would scrub.
    const memberContent = pair.member.vault.vault
      .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
      .get(pair.assetId) as { content_id: string };
    pair.member.vault.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, 'core.content_item', ?, 'test@1', 1, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        memberContent.content_id,
        Buffer.from(new Float32Array([1]).buffer),
        new Date().toISOString()
      );
    // One steward write, executed and sequenced the way the rail does it: the
    // invocation is seeded with the operation's own replica key so the member
    // re-executing it lands on identical rows (#750 invariant 7).
    registerMediaCommands(pair.origin.gateway);
    registerMediaCommands(pair.member.gateway);
    const sequence =
      readCommonsGrant(pair.origin.vault.vault, pair.grantId).lastSequence + 1;
    const commandInput = { asset_id: pair.assetId, favorite: 1 };
    expect(
      pair.origin.gateway.invokeCommonsCanonical(
        pair.origin.ownerCredential,
        {
          command: "media.update_asset",
          input: commandInput,
          purpose: "dpv:ServiceProvision",
        },
        { idSeed: replicaInvocationKey(pair.grantId, sequence) }
      ).status
    ).toBe("executed");
    appendCommonsOperation({
      steward: pair.origin.vault.vault,
      grantId: pair.grantId,
      actorPartyId: pair.origin.ownerPartyId,
      kind: "command",
      command: "media.update_asset",
      input: commandInput,
      outcome: "executed",
      now: new Date().toISOString(),
    });
    const second = await pullPeerCommons({
      dial,
      route,
      stewardVaultId: pair.origin.vaultId,
      memberVaultId: pair.member.vaultId,
      grantId: pair.grantId,
      seat: pair.member.vault,
      // The replica executor: without it this seat cannot replay a tail and
      // every increment re-baselines instead.
      gateway: pair.member.gateway,
      credential: pair.member.ownerCredential,
    });
    expect(second).toMatchObject({ state: "current", sequence: 1 });
    expect(
      pair.member.vault.vault
        .prepare("SELECT favorite FROM media_asset WHERE asset_id = ?")
        .get(pair.assetId)
    ).toMatchObject({ favorite: 1 });
    expect(
      pair.member.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM enrich_embedding WHERE target_id = ?"
        )
        .get(memberContent.content_id)
    ).toMatchObject({ n: 1 });
    // Both pulls were appliable without a destructive re-baseline: the
    // durable record shows tails only — the fixed-window plan's signal that
    // no member was forced through the snapshot lane.
    expect(
      pair.member.vault.vault
        .prepare(
          `SELECT pull_snapshot, pull_tail, pull_unreachable
             FROM share_commons_steward_contact
            WHERE grant_id = ? AND member_vault_id = ?`
        )
        .get(pair.grantId, pair.member.vaultId)
    ).toMatchObject({ pull_snapshot: 0, pull_tail: 2, pull_unreachable: 0 });
  });

  test("a bootstrap frame past the member's page budget arrives as bounded pages", async () => {
    const bytes = crypto.randomBytes(64);
    const pair = await commonsPair("paged", bytes);
    // Inflate the frame well past the requested page budget.
    pair.origin.vault.vault
      .prepare("UPDATE core_content_item SET title = ? WHERE sha256 = ?")
      .run(`padded ${"x".repeat(16_000)}`, pair.sha256);
    const counted = countingDial(dialFrom(pair.member, pair.origin));
    const result = await pullPeerCommons({
      dial: counted.dial,
      route: { endpointId: pair.origin.endpointId, relayHints: [] },
      stewardVaultId: pair.origin.vaultId,
      memberVaultId: pair.member.vaultId,
      grantId: pair.grantId,
      seat: pair.member.vault,
      pageBytes: 4096,
    });
    expect(result).toMatchObject({ state: "current" });
    const pageCalls = counted.targets.filter((target) =>
      target.includes("session=")
    );
    expect(pageCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      pair.member.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(pair.assetId)
    ).toMatchObject({ n: 1 });
  });
});
