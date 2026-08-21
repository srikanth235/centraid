import { afterEach, describe, expect, test } from "vitest";

import { registerDocumentCommands } from "../commands/documents.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  removeCommonsMember,
  scrubCommonsSeat,
  upsertCommonsMember,
} from "./commons-lifecycle.js";
import { compileCommons, createCommonsGrant } from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

describe("Commons derived-state scrub", () => {
  afterEach(closeOpenVaults);

  test("removal clears local search, vectors, requests, faces and can be re-invited", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const shared = seedPhoto(origin, originBoot, "shared-derived");
    const ownerPhoto = seedPhoto(audience, audienceBoot, "owner-unrelated");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: shared.assetId,
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
    const seat = {
      partyId: audienceBoot.ownerPartyId,
      capability: "read" as const,
      vaultId: "vault-family",
      vault: audience,
    };
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [seat],
      now,
    });

    const regionId = uuidv7();
    audience.vault
      .prepare(
        `INSERT INTO media_face_region
           (region_id, asset_id, bbox_json, party_id, confidence,
            confirmed_by_party_id, review_state)
         VALUES (?, ?, '{"x":0.1,"y":0.1,"w":0.2,"h":0.2}', NULL,
                 0.9, NULL, 'proposed')`
      )
      .run(regionId, shared.assetId);
    const insertEmbedding = audience.vault.prepare(
      `INSERT INTO enrich_embedding
         (embedding_id, target_type, target_id, model, dim, vector, created_at)
       VALUES (?, ?, ?, 'test@1', 1, ?, ?)`
    );
    insertEmbedding.run(
      uuidv7(),
      "media.asset",
      shared.assetId,
      Buffer.from(new Float32Array([1]).buffer),
      now
    );
    insertEmbedding.run(
      uuidv7(),
      "core.content_item",
      shared.contentId,
      Buffer.from(new Float32Array([1]).buffer),
      now
    );
    insertEmbedding.run(
      uuidv7(),
      "media.face_region",
      regionId,
      Buffer.from(new Float32Array([1]).buffer),
      now
    );
    insertEmbedding.run(
      uuidv7(),
      "media.asset",
      ownerPhoto.assetId,
      Buffer.from(new Float32Array([1]).buffer),
      now
    );
    audience.vault
      .prepare(
        `INSERT INTO enrich_derivation
           (derivation_id, target_type, target_id, variant, capability,
            model, payload_json, produced_at)
         VALUES (?, 'media.asset', ?, 'caption', 'captions',
                 'test@1', '{"local":true}', ?)`
      )
      .run(uuidv7(), shared.assetId, now);
    const insertRequest = audience.vault.prepare(
      `INSERT INTO enrich_request
         (request_id, target_type, target_id, reason, detail,
          requested_at, drained_at)
       VALUES (?, 'media.asset', ?, 'projected', 'local', ?, ?)`
    );
    insertRequest.run(uuidv7(), shared.assetId, now, null);
    insertRequest.run(uuidv7(), shared.assetId, now, now);
    audience.vault
      .prepare(
        `INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id,
            selector_json, body_text, created_at)
         VALUES (?, ?, 'media.asset', ?, NULL, 'local caption', ?)`
      )
      .run(uuidv7(), audienceBoot.ownerPartyId, shared.assetId, now);
    audience.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type,
            byte_size, text_content, created_at)
         VALUES (?, ?, 'text', NULL, 'text/plain', 18,
                 'audienceonlyneedle', ?)`
      )
      .run(uuidv7(), shared.contentId, now);
    audience.vault
      .prepare(
        `INSERT INTO home_asset_item
           (item_id, owner_party_id, name, photo_asset_id, updated_at)
         VALUES ('owner-item', ?, 'Owner item', ?, ?)`
      )
      .run(audienceBoot.ownerPartyId, shared.assetId, now);
    audience.vault
      .prepare("UPDATE media_asset SET source_asset_id = ? WHERE asset_id = ?")
      .run(shared.assetId, ownerPhoto.assetId);
    expect(
      audience.vault
        .prepare(
          "SELECT content_id FROM fts_core_content_item WHERE fts_core_content_item MATCH 'audienceonlyneedle'"
        )
        .all()
    ).toMatchObject([{ content_id: shared.contentId }]);

    removeCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      memberPartyId: audienceBoot.ownerPartyId,
      now,
    });
    scrubCommonsSeat({ seat: audience, grantId: grant.grantId });

    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(shared.assetId)
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM media_face_region WHERE region_id = ?"
        )
        .get(regionId)
    ).toMatchObject({ n: 0 });
    for (const table of [
      "enrich_embedding",
      "enrich_derivation",
      "enrich_request",
      "knowledge_annotation",
    ]) {
      expect(
        audience.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE target_id IN (?, ?, ?)`
          )
          .get(shared.assetId, shared.contentId, regionId),
        table
      ).toMatchObject({ n: 0 });
    }
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM fts_core_content_item WHERE fts_core_content_item MATCH 'audienceonlyneedle'"
        )
        .get()
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          "SELECT photo_asset_id FROM home_asset_item WHERE item_id = 'owner-item'"
        )
        .get()
    ).toMatchObject({ photo_asset_id: null });
    expect(
      audience.vault
        .prepare("SELECT source_asset_id FROM media_asset WHERE asset_id = ?")
        .get(ownerPhoto.assetId)
    ).toMatchObject({ source_asset_id: null });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM enrich_embedding WHERE target_id = ?"
        )
        .get(ownerPhoto.assetId)
    ).toMatchObject({ n: 1 });

    upsertCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      member: {
        partyId: audienceBoot.ownerPartyId,
        capability: "read",
        vaultId: "vault-family",
        vault: audience,
      },
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [seat],
      now,
    });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_asset WHERE asset_id = ?")
        .get(shared.assetId)
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM fts_core_content_item WHERE fts_core_content_item MATCH 'audienceonlyneedle'"
        )
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("sha-dedup keeps receiver-owned content and its local derived state", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const originGateway = createGateway(origin);
    const audienceGateway = createGateway(audience);
    registerDocumentCommands(originGateway);
    registerDocumentCommands(audienceGateway);
    const originCredential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const audienceCredential: Credential = {
      kind: "device",
      deviceId: audienceBoot.deviceId,
      deviceKey: audienceBoot.deviceKey,
    };
    const add = (
      gateway: ReturnType<typeof createGateway>,
      credential: Credential,
      title: string
    ) => {
      const staged = gateway.stageBlob(credential, {
        bytes: Buffer.from("the-same-document-bytes"),
        filename: "same.txt",
        mediaType: "text/plain",
      });
      const outcome = gateway.invoke(credential, {
        command: "core.add_document",
        input: {
          title,
          staged_sha: staged.sha256,
        },
      });
      if (outcome.status !== "executed")
        throw new Error(`document creation failed: ${JSON.stringify(outcome)}`);
      return outcome.output as { document_id: string; content_id: string };
    };
    const shared = add(originGateway, originCredential, "Shared title");
    const owned = add(audienceGateway, audienceCredential, "Owner title");
    audience.vault
      .prepare(
        `UPDATE core_content_derivative
            SET text_content = 'ownerdedupneedle', byte_size = 16
          WHERE content_id = ? AND variant = 'text'`
      )
      .run(owned.content_id);
    audience.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, 'core.content_item', ?, 'test@1', 1, ?, ?)`
      )
      .run(
        uuidv7(),
        owned.content_id,
        Buffer.from(new Float32Array([1]).buffer),
        now
      );
    audience.vault
      .prepare(
        `INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id,
            selector_json, body_text, created_at)
         VALUES (?, ?, 'core.content_item', ?, NULL, 'owner annotation', ?)`
      )
      .run(uuidv7(), audienceBoot.ownerPartyId, owned.content_id, now);
    const sha = (
      audience.vault
        .prepare("SELECT sha256 FROM core_content_item WHERE content_id = ?")
        .get(owned.content_id) as { sha256: string }
    ).sha256;
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "core.document",
      containerId: shared.document_id,
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
    expect(
      audience.vault
        .prepare(
          "SELECT current_content_id FROM core_document WHERE document_id = ?"
        )
        .get(shared.document_id)
    ).toMatchObject({ current_content_id: owned.content_id });

    removeCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      memberPartyId: audienceBoot.ownerPartyId,
      now,
    });
    scrubCommonsSeat({ seat: audience, grantId: grant.grantId });

    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_document WHERE document_id = ?"
        )
        .get(shared.document_id)
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          "SELECT current_content_id FROM core_document WHERE document_id = ?"
        )
        .get(owned.document_id)
    ).toMatchObject({ current_content_id: owned.content_id });
    expect(
      audience.vault
        .prepare(
          "SELECT text_content FROM core_content_derivative WHERE content_id = ?"
        )
        .get(owned.content_id)
    ).toMatchObject({ text_content: "ownerdedupneedle" });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM enrich_embedding WHERE target_id = ?"
        )
        .get(owned.content_id)
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_annotation WHERE target_id = ?"
        )
        .get(owned.content_id)
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM fts_core_document WHERE fts_core_document MATCH 'ownerdedupneedle'"
        )
        .get()
    ).toMatchObject({ n: 1 });
    expect(audience.blobs.local.hasSync(sha)).toBe(true);
  });
});
