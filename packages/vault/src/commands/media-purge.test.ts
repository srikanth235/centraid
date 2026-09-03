import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerMediaCommands } from "./media.js";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OTHER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const THIRD = "data:video/mp4;base64,AAAAHGZ0eXBpc29t";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("media: purge_asset", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerMediaCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(
    command: string,
    input: Record<string, unknown>,
    cred: Credential = owner
  ) {
    return gw.invoke(cred, { command, input, purpose: "dpv:ServiceProvision" });
  }

  function addAsset(dataUri: string, extra: Record<string, unknown> = {}) {
    const outcome = invoke("media.add_asset", { data_uri: dataUri, ...extra });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { asset_id: string; content_id: string } })
      .output;
  }

  function trashed(dataUri: string, extra: Record<string, unknown> = {}) {
    const asset = addAsset(dataUri, extra);
    expect(
      invoke("media.delete_asset", { asset_id: asset.asset_id }).status
    ).toBe("executed");
    return asset;
  }

  function count(sql: string, ...params: string[]): number {
    return (db.vault.prepare(sql).get(...params) as { n: number }).n;
  }

  test("a trashed asset purges: the row, its faces and its phash all go", () => {
    const asset = trashed(PIXEL);
    const conceptId = boot.concepts["dpv:ServiceProvision"] ?? "";
    db.vault
      .prepare(
        `INSERT INTO media_face_region (region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id)
         VALUES ('face-1', ?, '{"x":0}', NULL, 0.9, NULL)`
      )
      .run(asset.asset_id);
    db.vault
      .prepare(
        `INSERT INTO media_asset_phash (asset_id, phash, cluster_id, computed_at)
         VALUES (?, 'abcd', NULL, '2026-01-01T00:00:00Z')`
      )
      .run(asset.asset_id);
    db.vault
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
         VALUES ('tag-1', 'media.asset', ?, ?, NULL, NULL, '2026-01-01T00:00:00Z')`
      )
      .run(asset.asset_id, conceptId);
    db.vault
      .prepare(
        `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, selector_json, body_text, created_at)
         VALUES ('anno-1', ?, 'media.asset', ?, NULL, 'the light here', '2026-01-01T00:00:00Z')`
      )
      .run(boot.ownerPartyId, asset.asset_id);
    db.vault
      .prepare(
        `INSERT INTO core_link (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, valid_to, asserted_by, provenance_id)
         VALUES ('link-1', 'media.asset', ?, 'core.party', ?, ?, '2026-01-01T00:00:00Z', NULL, 'owner', NULL)`
      )
      .run(asset.asset_id, boot.ownerPartyId, conceptId);

    const outcome = invoke("media.purge_asset", { asset_id: asset.asset_id });
    expect(outcome.status).toBe("executed");

    expect(
      count(
        "SELECT count(*) AS n FROM media_asset WHERE asset_id = ?",
        asset.asset_id
      )
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM media_face_region WHERE asset_id = ?",
        asset.asset_id
      )
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM media_asset_phash WHERE asset_id = ?",
        asset.asset_id
      )
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM core_tag WHERE target_id = ?",
        asset.asset_id
      )
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM knowledge_annotation WHERE target_id = ?",
        asset.asset_id
      )
    ).toBe(0);
    expect(
      db.vault
        .prepare("SELECT valid_to FROM core_link WHERE link_id = 'link-1'")
        .get()
    ).toBeUndefined();
  });

  test("purging hands the bytes to the next sweep, not to nobody", () => {
    const asset = trashed(PIXEL);
    expect(
      invoke("media.purge_asset", { asset_id: asset.asset_id }).status
    ).toBe("executed");
    const content = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?"
      )
      .get(asset.content_id) as {
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect(content.deleted_at).not.toBeNull();
    expect(content.purge_at).not.toBeNull();
    expect(Date.parse(content.purge_at!)).toBeLessThanOrEqual(Date.now());
  });

  test("a LIVE asset is refused, not purged", () => {
    const asset = addAsset(PIXEL);
    const outcome = invoke("media.purge_asset", { asset_id: asset.asset_id });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toContain("already in the trash");
    expect(
      count(
        "SELECT count(*) AS n FROM media_asset WHERE asset_id = ?",
        asset.asset_id
      )
    ).toBe(1);
  });

  test("an asset id that names nothing is refused by the same guard", () => {
    const outcome = invoke("media.purge_asset", { asset_id: "not-an-asset" });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toContain("already in the trash");
  });

  test("purging an edit's source is refused while the edit still names it", () => {
    const original = addAsset(PIXEL);
    const edit = addAsset(OTHER, { source_asset_id: original.asset_id });
    expect(
      invoke("media.delete_asset", { asset_id: original.asset_id }).status
    ).toBe("executed");

    const refused = invoke("media.purge_asset", {
      asset_id: original.asset_id,
    });
    expect(refused.status).toBe("failed");
    assert(refused.status === "failed");
    expect(refused.reason).toContain("edited copy");
    expect(
      count(
        "SELECT count(*) AS n FROM media_asset WHERE asset_id = ?",
        original.asset_id
      )
    ).toBe(1);

    expect(
      invoke("media.delete_asset", { asset_id: edit.asset_id }).status
    ).toBe("executed");
    expect(
      invoke("media.purge_asset", { asset_id: edit.asset_id }).status
    ).toBe("executed");
    expect(
      invoke("media.purge_asset", { asset_id: original.asset_id }).status
    ).toBe("executed");
  });

  test("a caller whose grant cannot act on the command is denied", () => {
    const asset = trashed(PIXEL);
    const app = enrollApp(db, { name: "viewer" });
    const appCred: Credential = {
      kind: "app",
      appId: app.appId,
      signingKey: app.signingKey,
    };
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] ?? "",
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        { schema: "media", verbs: "read" },
        { schema: "media", table: "delete_asset", verbs: "act" },
      ],
    });
    const denied = invoke(
      "media.purge_asset",
      { asset_id: asset.asset_id },
      appCred
    );
    expect(denied.status).toBe("denied");
    expect(
      count(
        "SELECT count(*) AS n FROM media_asset WHERE asset_id = ?",
        asset.asset_id
      )
    ).toBe(1);
  });

  test("an album whose cover was purged falls back to its next photograph", () => {
    const albumOutcome = invoke("media.create_album", { title: "Paris" });
    expect(albumOutcome.status).toBe("executed");
    const albumId = (albumOutcome as { output: { album_id: string } }).output
      .album_id;
    const cover = addAsset(PIXEL);
    const next = addAsset(THIRD);
    for (const asset of [cover, next]) {
      expect(
        invoke("media.add_to_album", {
          album_id: albumId,
          asset_id: asset.asset_id,
        }).status
      ).toBe("executed");
    }
    expect(
      invoke("media.delete_asset", { asset_id: cover.asset_id }).status
    ).toBe("executed");
    expect(
      invoke("media.add_to_album", {
        album_id: albumId,
        asset_id: cover.asset_id,
      }).status
    ).toBe("executed");
    expect(
      invoke("media.purge_asset", { asset_id: cover.asset_id }).status
    ).toBe("executed");
    const album = db.vault
      .prepare(
        "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
      )
      .get(albumId) as { cover_content_id: string | null };
    expect(album.cover_content_id).toBe(next.content_id);
    expect(
      count(
        "SELECT count(*) AS n FROM core_collection_entry WHERE target_id = ?",
        cover.asset_id
      )
    ).toBe(0);
  });
});
