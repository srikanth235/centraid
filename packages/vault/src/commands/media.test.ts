import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerAttachmentCommands } from "./attachments.js";
import { registerMediaCommands } from "./media.js";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const CLIP = "data:video/mp4;base64,AAAAHGZ0eXBpc29t";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("media", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerMediaCommands(gw);
    registerAttachmentCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command,
      input,
    });
  }

  function addAsset(input: Record<string, unknown>): {
    asset_id: string;
    content_id: string;
  } {
    const outcome = invoke("media.add_asset", input);
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { asset_id: string; content_id: string } })
      .output;
  }

  function createAlbum(title: string): string {
    const outcome = invoke("media.create_album", { title });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { album_id: string } }).output.album_id;
  }

  test("add_asset lands content item + asset, kind inferred from the media type", () => {
    const photo = addAsset({
      data_uri: PIXEL,
      captured_at: "2026-06-01T10:00:00Z",
    });
    const clip = addAsset({ data_uri: CLIP });
    const photoRow = db.vault
      .prepare("SELECT kind, captured_at FROM media_asset WHERE asset_id = ?")
      .get(photo.asset_id) as { kind: string; captured_at: string };
    expect(photoRow).toMatchObject({
      kind: "photo",
      captured_at: "2026-06-01T10:00:00Z",
    });
    const clipRow = db.vault
      .prepare("SELECT kind FROM media_asset WHERE asset_id = ?")
      .get(clip.asset_id) as { kind: string };
    expect(clipRow.kind).toBe("video");
  });

  test("add_asset preserves a logical capture group for Live Photo companions", () => {
    const photo = addAsset({
      data_uri: PIXEL,
      capture_group_id: "live:camera-42",
    });
    const clip = addAsset({
      data_uri: CLIP,
      capture_group_id: "live:camera-42",
    });
    const groups = db.vault
      .prepare("SELECT kind, capture_group_id FROM media_asset ORDER BY kind")
      .all() as Array<{ kind: string; capture_group_id: string }>;
    expect([photo.asset_id, clip.asset_id]).toHaveLength(2);
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect(groups.map((row) => ({ ...row }))).toStrictEqual([
      { kind: "photo", capture_group_id: "live:camera-42" },
      { kind: "video", capture_group_id: "live:camera-42" },
    ]);
  });

  test("add_asset records the asset an edited copy was derived from", () => {
    const original = addAsset({
      data_uri: PIXEL,
      captured_at: "2026-03-04T09:00:00Z",
    });
    // A crop of it: different bytes, saved today, pointing at its source.
    const edited = addAsset({
      data_uri: CLIP,
      captured_at: "2026-08-05T12:00:00Z",
      source_asset_id: original.asset_id,
    });
    const rows = db.vault
      .prepare(
        "SELECT asset_id, source_asset_id FROM media_asset ORDER BY captured_at"
      )
      .all() as Array<{ asset_id: string; source_asset_id: string | null }>;
    expect(rows.map((row) => ({ ...row }))).toStrictEqual([
      // The original was derived from nothing, and says so.
      { asset_id: original.asset_id, source_asset_id: null },
      { asset_id: edited.asset_id, source_asset_id: original.asset_id },
    ]);
  });

  test("add_asset refuses a source that is not an asset in this vault", () => {
    const outcome = invoke("media.add_asset", {
      data_uri: PIXEL,
      source_asset_id: "asset-that-never-existed",
    });
    // A missed precondition is a `failed` outcome, not a raw FK error from
    // the middle of the insert — and nothing lands.
    expect(outcome.status).toBe("failed");
    const count = db.vault
      .prepare("SELECT count(*) AS n FROM media_asset")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("add_asset dedupes identical bytes onto one asset (content_id is UNIQUE)", () => {
    const first = addAsset({ data_uri: PIXEL });
    const second = invoke("media.add_asset", { data_uri: PIXEL });
    expect(second.status).toBe("executed");
    const output = (second as { output: { asset_id: string; deduped: number } })
      .output;
    expect(output.asset_id).toBe(first.asset_id);
    expect(output.deduped).toBe(1);
  });

  test("update_asset revises capture time and caption (title on the content item)", () => {
    const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
    const outcome = invoke("media.update_asset", {
      asset_id,
      captured_at: "2025-12-25T08:00:00Z",
      title: "Christmas morning",
    });
    expect(outcome.status).toBe("executed");
    const content = db.vault
      .prepare("SELECT title FROM core_content_item WHERE content_id = ?")
      .get(content_id) as { title: string };
    expect(content.title).toBe("Christmas morning");
  });

  test("albums: entries keep positions, first photo becomes cover, cover hands off on removal", () => {
    const a = addAsset({ data_uri: PIXEL });
    const b = addAsset({ data_uri: CLIP });
    const albumId = createAlbum("Trip");
    expect(
      invoke("media.add_to_album", { album_id: albumId, asset_id: a.asset_id })
        .status
    ).toBe("executed");
    expect(
      invoke("media.add_to_album", { album_id: albumId, asset_id: b.asset_id })
        .status
    ).toBe("executed");
    let album = db.vault
      .prepare(
        "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
      )
      .get(albumId) as { cover_content_id: string };
    expect(album.cover_content_id).toBe(a.content_id);
    expect(
      invoke("media.set_album_cover", {
        album_id: albumId,
        asset_id: b.asset_id,
      }).status
    ).toBe("executed");
    album = db.vault
      .prepare(
        "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
      )
      .get(albumId) as { cover_content_id: string };
    expect(album.cover_content_id).toBe(b.content_id);
    expect(
      invoke("media.set_album_cover", {
        album_id: albumId,
        asset_id: "not-a-member",
      }).status
    ).toBe("failed");
    // Twice into the same album is a receipted refusal, not a UNIQUE throw.
    const dup = invoke("media.add_to_album", {
      album_id: albumId,
      asset_id: a.asset_id,
    });
    expect(dup.status).toBe("failed");
    expect(
      invoke("media.remove_from_album", {
        album_id: albumId,
        asset_id: a.asset_id,
      }).status
    ).toBe("executed");
    album = db.vault
      .prepare(
        "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
      )
      .get(albumId) as { cover_content_id: string };
    expect(album.cover_content_id).toBe(b.content_id);
  });

  test("delete_album undo restores metadata, ordered membership, and cover without touching assets", () => {
    const first = addAsset({ data_uri: PIXEL });
    const second = addAsset({ data_uri: CLIP });
    const albumId = createAlbum("Trip");
    invoke("media.add_to_album", {
      album_id: albumId,
      asset_id: first.asset_id,
    });
    invoke("media.add_to_album", {
      album_id: albumId,
      asset_id: second.asset_id,
    });
    invoke("media.set_album_cover", {
      album_id: albumId,
      asset_id: second.asset_id,
    });
    expect(
      invoke("media.rename_album", { album_id: albumId, title: "Goa 2026" })
        .status
    ).toBe("executed");
    const deleted = invoke("media.delete_album", { album_id: albumId });
    expect(deleted.status).toBe("executed");
    const revision = (
      deleted as { output: { revision_id: string; undo_until: string } }
    ).output;
    expect(Date.parse(revision.undo_until)).toBeGreaterThan(Date.now());
    expect(
      invoke("media.restore_album", {
        album_id: albumId,
        revision_id: revision.revision_id,
      }).status
    ).toBe("executed");
    const album = db.vault
      .prepare(
        `SELECT name, cover_content_id FROM core_collection
          WHERE collection_id = ?`
      )
      .get(albumId) as { name: string; cover_content_id: string };
    expect({ ...album }).toStrictEqual({
      name: "Goa 2026",
      cover_content_id: second.content_id,
    });
    expect(
      (
        db.vault
          .prepare(
            `SELECT target_id, position FROM core_collection_entry
              WHERE collection_id = ? ORDER BY position`
          )
          .all(albumId) as Array<{ target_id: string; position: number }>
      ).map((row) => ({ ...row }))
    ).toStrictEqual([
      { target_id: first.asset_id, position: 0 },
      { target_id: second.asset_id, position: 1 },
    ]);
    expect(
      invoke("media.restore_album", {
        album_id: albumId,
        revision_id: revision.revision_id,
      }).status
    ).toBe("failed");
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM media_asset").get() as {
          n: number;
        }
      ).n
    ).toBe(2);
  });

  test("delete_album removes only the collection when undo is not used", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    const albumId = createAlbum("Trip");
    invoke("media.add_to_album", { album_id: albumId, asset_id });
    expect(invoke("media.delete_album", { album_id: albumId }).status).toBe(
      "executed"
    );
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM core_collection").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM media_asset").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  test("delete_asset trashes the asset, leaves albums, and soft-deletes unreferenced bytes", () => {
    const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
    const albumId = createAlbum("Trip");
    invoke("media.add_to_album", { album_id: albumId, asset_id });
    const outcome = invoke("media.delete_asset", { asset_id });
    expect(outcome.status).toBe("executed");
    expect(
      (outcome as { output: { content_released: number } }).output
        .content_released
    ).toBe(1);
    const entries = db.vault
      .prepare("SELECT count(*) AS n FROM core_collection_entry")
      .get() as {
      n: number;
    };
    expect(entries.n).toBe(0);
    const album = db.vault
      .prepare(
        "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
      )
      .get(albumId) as { cover_content_id: string | null };
    expect(album.cover_content_id).toBeNull();
    // The asset row survives in the trash with its own grace window (issue
    // #274) — restore can bring it back whole.
    const asset = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM media_asset WHERE asset_id = ?"
      )
      .get(asset_id) as { deleted_at: string | null; purge_at: string | null };
    expect(asset.deleted_at).not.toBeNull();
    expect(asset.purge_at).not.toBeNull();
    const content = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?"
      )
      .get(content_id) as {
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect(content.deleted_at).not.toBeNull();
    expect(content.purge_at).not.toBeNull();
    // Trash is one-way per asset: a second delete fails its precondition.
    const again = invoke("media.delete_asset", { asset_id });
    expect(again.status).toBe("failed");
  });

  test("the star is one tag on the asset; archive stays a column (#916)", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    // ONE TRUTH (#916). There was a `media_asset.favorite` column AND a
    // `starred` flags tag on the asset's CONTENT ITEM, kept in step by a
    // mirror helper every writer had to remember; the importers and the share
    // projection did not. The column is gone and the tag anchors on
    // `media.asset` — the entity Photos shows, and the one a member points at.
    const starred = () =>
      (
        db.vault
          .prepare(
            `SELECT t.target_id AS id FROM core_tag t
             JOIN core_concept c ON c.concept_id = t.concept_id
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE t.target_type = 'media.asset'
              AND s.uri = 'https://centraid.dev/schemes/flags'
              AND c.notation = 'starred'`
          )
          .all() as { id: string }[]
      ).map((row) => row.id);
    const archivedAt = () =>
      (
        db.vault
          .prepare("SELECT archived_at FROM media_asset WHERE asset_id = ?")
          .get(asset_id) as { archived_at: string | null }
      ).archived_at;

    expect(starred()).not.toContain(asset_id);
    expect(archivedAt()).toBeNull();

    // update_asset stays the general editor; set_favorite is the focused toggle.
    expect(invoke("media.update_asset", { asset_id, favorite: 1 }).status).toBe(
      "executed"
    );
    expect(starred()).toContain(asset_id);
    expect(invoke("media.set_favorite", { asset_id, favorite: 1 }).status).toBe(
      "executed"
    );
    expect(starred().filter((id) => id === asset_id)).toHaveLength(1);
    expect(invoke("media.set_favorite", { asset_id, favorite: 0 }).status).toBe(
      "executed"
    );
    expect(starred()).not.toContain(asset_id);

    // Archive is a nullable timestamp; toggling on stamps it, off clears it.
    expect(invoke("media.set_archived", { asset_id, archived: 1 }).status).toBe(
      "executed"
    );
    expect(archivedAt()).not.toBeNull();
    expect(invoke("media.set_archived", { asset_id, archived: 0 }).status).toBe(
      "executed"
    );
    expect(archivedAt()).toBeNull();
  });

  test("a TRASHED asset can be neither starred nor archived (#916)", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    expect(invoke("media.delete_asset", { asset_id }).status).toBe("executed");
    // Photos could star and archive a photograph the member had already
    // thrown away: the precondition asked only that the row exist.
    expect(invoke("media.set_favorite", { asset_id, favorite: 1 }).status).toBe(
      "failed"
    );
    expect(invoke("media.set_archived", { asset_id, archived: 1 }).status).toBe(
      "failed"
    );
  });

  test("add_asset carries tz_offset_min and a device thumbhash onto the asset", () => {
    const { asset_id, content_id } = addAsset({
      data_uri: PIXEL,
      captured_at: "2026-06-01T10:00:00Z",
      tz_offset_min: 330,
      thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    });
    const asset = db.vault
      .prepare("SELECT tz_offset_min FROM media_asset WHERE asset_id = ?")
      .get(asset_id) as { tz_offset_min: number };
    expect(asset.tz_offset_min).toBe(330);
    const derivative = db.vault
      .prepare(
        `SELECT media_type, text_content FROM core_content_derivative
        WHERE content_id = ? AND variant = 'thumbhash'`
      )
      .get(content_id) as { media_type: string; text_content: string };
    expect({ ...derivative }).toStrictEqual({
      media_type: "application/x-thumbhash",
      text_content: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    });
  });

  test("restore_asset brings a trashed asset and its bytes back; restoring live fails", () => {
    const { asset_id, content_id } = addAsset({
      data_uri: PIXEL,
      captured_at: "2026-01-01T00:00:00Z",
    });
    // Restoring a live asset is a receipted refusal.
    expect(invoke("media.restore_asset", { asset_id }).status).toBe("failed");
    invoke("media.delete_asset", { asset_id });
    const outcome = invoke("media.restore_asset", { asset_id });
    expect(outcome.status).toBe("executed");
    const asset = db.vault
      .prepare(
        "SELECT deleted_at, captured_at FROM media_asset WHERE asset_id = ?"
      )
      .get(asset_id) as { deleted_at: string | null; captured_at: string };
    expect(asset.deleted_at).toBeNull();
    expect(asset.captured_at).toBe("2026-01-01T00:00:00Z"); // metadata survives the round trip
    const content = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?"
      )
      .get(content_id) as {
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect(content.deleted_at).toBeNull();
    expect(content.purge_at).toBeNull();
  });

  test("delete_asset keeps bytes another canonical row still rents", () => {
    const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
    // The same bytes also ride as an attachment on the owner party.
    const attach = invoke("core.attach", {
      subject_type: "core.party",
      subject_id: boot.ownerPartyId,
      data_uri: PIXEL,
    });
    expect(attach.status).toBe("executed");
    const outcome = invoke("media.delete_asset", { asset_id });
    expect(outcome.status).toBe("executed");
    expect(
      (outcome as { output: { content_released: number } }).output
        .content_released
    ).toBe(0);
    const content = db.vault
      .prepare("SELECT deleted_at FROM core_content_item WHERE content_id = ?")
      .get(content_id) as { deleted_at: string | null };
    expect(content.deleted_at).toBeNull();
  });

  test("re-uploading trashed bytes restores them", () => {
    const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
    invoke("media.delete_asset", { asset_id });
    const again = addAsset({ data_uri: PIXEL });
    expect(again.content_id).toBe(content_id);
    const content = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?"
      )
      .get(content_id) as {
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect(content.deleted_at).toBeNull();
    expect(content.purge_at).toBeNull();
  });
});
