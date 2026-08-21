import { afterEach, describe, expect, test } from "vitest";

import { registerDocumentCommands } from "../commands/documents.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  applyCommonsBootstrap,
  applyCommonsTombstone,
  exportCommonsBootstrap,
  exportCommonsSyncFrame,
} from "./commons-bootstrap.js";
import { revokeCommonsGrant } from "./commons-lifecycle.js";
import {
  compileCommons,
  createCommonsGrant,
  retainCommonsItem,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

describe("Commons whole-container retain", () => {
  afterEach(closeOpenVaults);

  test("saved Docs folder keeps its subtree and bytes through later bootstrap and revoke", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const gateway = createGateway(origin);
    registerDocumentCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const invoke = (command: string, input: Record<string, unknown>) => {
      const outcome = gateway.invoke(owner, { command, input });
      if (outcome.status !== "executed")
        throw new Error(`${command} failed: ${JSON.stringify(outcome)}`);
      return outcome.output as Record<string, string>;
    };
    const root = invoke("core.create_folder", { name: "Trip" })["folder_id"]!;
    const child = invoke("core.create_folder", {
      name: "Bookings",
      parent_folder_id: root,
    })["folder_id"]!;
    const staged = gateway.stageBlob(owner, {
      bytes: Buffer.from("saved folder bytes"),
      filename: "booking.txt",
      mediaType: "text/plain",
    });
    const document = invoke("core.add_document", {
      folder_id: child,
      title: "Booking",
      staged_sha: staged.sha256,
    }) as { document_id: string; content_id: string };
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "docs.folder",
      containerId: root,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    const seats = [
      {
        partyId: audienceBoot.ownerPartyId,
        capability: "read" as const,
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
    retainCommonsItem({
      seat: audience.vault,
      itemType: "docs.folder",
      itemId: root,
      now,
    });
    origin.vault
      .prepare(
        "UPDATE core_document SET title = 'Origin changed' WHERE document_id = ?"
      )
      .run(document.document_id);
    applyCommonsBootstrap({
      seat: audience,
      wire: exportCommonsBootstrap({
        steward: origin.vault,
        identitySeed: origin.identitySeed,
        stewardVaultId: "vault-priya",
        grantId: grant.grantId,
        memberVaultId: "vault-family",
      }),
      now,
    });
    expect(
      audience.vault
        .prepare("SELECT title FROM core_document WHERE document_id = ?")
        .get(document.document_id)
    ).toMatchObject({ title: "Booking" });
    revokeCommonsGrant({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });
    const frame = exportCommonsSyncFrame({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    if (frame.state !== "tombstone") throw new Error("expected tombstone");
    applyCommonsTombstone({ seat: audience, tombstone: frame.tombstone });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_concept WHERE concept_id IN (?, ?)"
        )
        .get(root, child)
    ).toMatchObject({ n: 2 });
    expect(
      audience.vault
        .prepare(
          "SELECT current_content_id FROM core_document WHERE document_id = ?"
        )
        .get(document.document_id)
    ).toMatchObject({ current_content_id: document.content_id });
    expect(audience.blobs.local.hasSync(staged.sha256)).toBe(true);
  });

  test("saved album keeps every asset, entry, and source byte after revoke", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const first = seedPhoto(origin, originBoot, "album-first");
    const second = seedPhoto(origin, originBoot, "album-second");
    const collectionId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Album', ?, NULL, 0, ?)`
      )
      .run(collectionId, originBoot.ownerPartyId, first.contentId, now);
    const add = origin.vault.prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, ?, ?)`
    );
    add.run(uuidv7(), collectionId, first.assetId, 0, now);
    add.run(uuidv7(), collectionId, second.assetId, 1, now);
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "core.collection",
      containerId: collectionId,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    retainCommonsItem({
      seat: audience.vault,
      itemType: "core.collection",
      itemId: collectionId,
      now,
    });
    applyCommonsBootstrap({
      seat: audience,
      wire: exportCommonsBootstrap({
        steward: origin.vault,
        identitySeed: origin.identitySeed,
        stewardVaultId: "vault-priya",
        grantId: grant.grantId,
        memberVaultId: "vault-family",
      }),
      now,
    });
    revokeCommonsGrant({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });
    const frame = exportCommonsSyncFrame({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    if (frame.state !== "tombstone") throw new Error("expected tombstone");
    applyCommonsTombstone({ seat: audience, tombstone: frame.tombstone });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_collection_entry WHERE collection_id = ?"
        )
        .get(collectionId)
    ).toMatchObject({ n: 2 });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 2 });
    expect(audience.blobs.local.hasSync(first.sha256)).toBe(true);
    expect(audience.blobs.local.hasSync(second.sha256)).toBe(true);
  });
});
