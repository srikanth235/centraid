/*
 * THE CLOSURE PREDICATE AND ITS THREE OUTPUTS (#996, R10), on a real vault.
 *
 * Written red-first against the transport that shipped: the first case here
 * fails on `project-closure.ts`'s derivative walk, which wrote a generated
 * caption, an OCR pass, a transcript, an embedding and a thumbnail into the
 * AUDIENCE vault — the R10 violation this wave exists to close.
 *
 * The other four are the outputs themselves, each measured against the log
 * rather than assumed: an existing photograph joining a shared album writes
 * ONE log row and moves FOUR rows into scope, so nothing but the member-set
 * diff can answer `enter`; the same subtraction in reverse answers `leave`,
 * for rows that did not themselves change; and a single field edit produces
 * two log rows (the write and `touch_updated_at`'s bump), so `update` must
 * coalesce by `(table, pk)` or every edit crosses the boundary twice.
 */

import { afterEach, describe, expect, test } from "vitest";

import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import { replicaLogState } from "../replica/log.js";
import {
  memberKey,
  memberPrimaryKey,
  readShareMembers,
  shareClosureMembers,
  SHARE_DERIVED_TABLES,
} from "./closure-members.js";
import type { ShareClosureOutputs } from "./closure-outputs.js";
import { commitShareClosureDiff, diffShareClosure } from "./closure-outputs.js";
import {
  addToAlbum,
  closeOpenVaults,
  household,
  inCommit,
  seedAlbum,
  seedPhoto,
} from "./placement-fixture.js";
import { projectShareClosure } from "./project-closure.js";
import { readShareClosure } from "./read-closure.js";

const ORIGIN_VAULT = "vault-priya";
const AUTHORITY = "authority-album";

function albumClosure(origin: VaultDb, collectionId: string) {
  return readShareClosure(origin.vault, {
    originVaultId: ORIGIN_VAULT,
    itemType: "core.collection",
    itemIds: [collectionId],
    crossOwner: true,
  });
}

/** One pass of the origin's side: closure, member set, diff, commit. */
function pass(
  origin: VaultDb,
  collectionId: string,
  since?: { epoch: string; seq: number },
  authorityId: string = AUTHORITY
): ShareClosureOutputs {
  const members = shareClosureMembers(
    origin.vault,
    albumClosure(origin, collectionId)
  );
  const outputs = diffShareClosure(origin.vault, {
    authorityId,
    members,
    ...(since === undefined ? {} : { since }),
  });
  commitShareClosureDiff(origin.vault, outputs, members);
  return outputs;
}

function tablesOf(rows: readonly { table: string }[]): string[] {
  return [...new Set(rows.map((row) => row.table))].toSorted();
}

describe("the closure predicate", () => {
  afterEach(closeOpenVaults);

  test("a derived row never crosses, and the recipient's own enrichment is what replaces it", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "caption");
    // An OCR pass and a transcript, exactly as an enricher writes them, plus
    // the GENERATED CAPTION — which since the representation split is an
    // annotation keyed to the asset rather than a column on it (R20(b)).
    for (const [variant, text] of [
      ["text", "BEACH CAFE"],
      ["transcript", "waves, then a dog barking"],
    ] as const)
      origin.vault
        .prepare(
          `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type,
              byte_size, text_content, created_at)
           VALUES (?, ?, ?, NULL, 'text/plain', ?, ?, ?)`
        )
        .run(uuidv7(), photo.contentId, variant, text.length, text, nowIso());
    const annotationId = uuidv7();
    origin.vault
      .prepare(
        "INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at) VALUES (?, 'media.asset', ?)"
      )
      .run(photo.assetId, nowIso());
    origin.vault
      .prepare(
        "INSERT INTO core_entity (entity_id, entity_type, created_at) VALUES (?, 'knowledge.annotation', ?)"
      )
      .run(annotationId, nowIso());
    origin.vault
      .prepare(
        `INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id,
            selector_json, body_text, created_at)
         VALUES (?, ?, 'media.asset', ?, NULL, ?, ?)`
      )
      .run(
        annotationId,
        originBoot.ownerPartyId,
        photo.assetId,
        "a dog on a beach at sunset",
        nowIso()
      );

    const closure = readShareClosure(origin.vault, {
      originVaultId: ORIGIN_VAULT,
      itemType: "media.asset",
      itemIds: [photo.assetId],
      crossOwner: true,
    });
    // Nothing in the closure names a derived row — not the caption, not the
    // OCR text, not the transcript, and not the thumbnail's bytes.
    expect(JSON.stringify(closure)).not.toContain("a dog on a beach");
    expect(JSON.stringify(closure)).not.toContain("BEACH CAFE");
    expect(closure.blobs.map((blob) => blob.rung)).toStrictEqual(["original"]);

    const members = shareClosureMembers(origin.vault, closure);
    for (const derived of SHARE_DERIVED_TABLES)
      expect(tablesOf([...members.values()])).not.toContain(derived);
    // The representation IS a member: it is the owner saying what the bytes
    // are (R20(b)), which is authored metadata, not a generated reading.
    expect(tablesOf([...members.values()])).toStrictEqual([
      "core_content_item",
      "core_content_representation",
      "media_asset",
    ]);

    projectShareClosure(audience.vault, closure, {
      grant: { authorityId: AUTHORITY, rowVersions: new Map() },
    });
    expect(
      (
        audience.vault
          .prepare("SELECT COUNT(*) AS n FROM core_content_derivative")
          .get() as { n: number }
      ).n
    ).toBe(0);
    // What the audience gets instead is the work, queued as its OWN (R18).
    expect(
      (
        audience.vault
          .prepare(
            `SELECT contribution_variant AS v FROM enrich_request
              WHERE reason = 'projected' ORDER BY contribution_variant`
          )
          .all() as unknown as { v: string }[]
      ).map((row) => row.v)
    ).toStrictEqual(["embedding", "phash", "thumb"]);
  });
});

describe("the three outputs", () => {
  afterEach(closeOpenVaults);

  test("an existing photograph added to a shared album ENTERS on four rows the log never mentions", () => {
    const { origin, originBoot } = household();
    const first = seedPhoto(origin, originBoot, "one");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Beach");
      addToAlbum(origin, id, { type: "media.asset", id: first.assetId });
      return id;
    });
    const bootstrap = pass(origin, album);
    expect(bootstrap.reason).toBe("resend");
    expect(bootstrap.leave).toStrictEqual([]);
    expect(tablesOf(bootstrap.enter)).toStrictEqual([
      "core_collection",
      "core_collection_entry",
      "core_content_item",
      "core_content_representation",
      "media_asset",
    ]);

    // A photograph the origin has held all along joins the album. Its own
    // rows were written and logged long before this pass, which is precisely
    // why the log has nothing to say about them entering.
    const second = inCommit(origin, () => seedPhoto(origin, originBoot, "two"));
    const before = replicaLogState(origin.vault).watermark;
    inCommit(origin, () =>
      addToAlbum(origin, album, { type: "media.asset", id: second.assetId }, 2)
    );
    const written = (
      origin.vault
        .prepare(
          `SELECT "table" AS t FROM replica_log WHERE seq > ? ORDER BY seq`
        )
        .all(before.seq) as unknown as { t: string }[]
    ).map((row) => row.t);
    // The entry row and its supertype registration: TWO log rows about the
    // filing itself, and not one word about the photograph.
    expect(written).toStrictEqual(["core_collection_entry", "core_entity"]);

    const outputs = pass(origin, album, before);
    expect(outputs.reason).toBe("tail");
    // ONE log row; FOUR rows enter. This is the measurement the ruling rests
    // on — the log alone cannot answer `enter`.
    expect(outputs.enter).toHaveLength(4);
    expect(tablesOf(outputs.enter)).toStrictEqual([
      "core_collection_entry",
      "core_content_item",
      "core_content_representation",
      "media_asset",
    ]);
    expect(outputs.leave).toStrictEqual([]);
    // Every enter carries a FULL image, not a pointer.
    for (const row of outputs.enter)
      expect(Object.keys(row.row).length).toBeGreaterThan(1);
  });

  test("a field edit on a member is ONE update, though the log holds two rows for it", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "rename");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Trip");
      addToAlbum(origin, id, { type: "media.asset", id: photo.assetId });
      return id;
    });
    pass(origin, album);
    const before = replicaLogState(origin.vault).watermark;

    inCommit(origin, () =>
      origin.vault
        .prepare("UPDATE media_asset SET title = ? WHERE asset_id = ?")
        .run("Renamed", photo.assetId)
    );
    const outputs = pass(origin, album, before);
    expect(outputs.enter).toStrictEqual([]);
    expect(outputs.leave).toStrictEqual([]);
    expect(outputs.update).toHaveLength(1);
    expect(outputs.update[0]!.table).toBe("media_asset");
    expect(outputs.update[0]!.row["title"]).toBe("Renamed");
  });

  test("a photograph removed from the album LEAVES on rows that did not themselves change", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "leaver");
    const keeper = seedPhoto(origin, originBoot, "keeper");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Album");
      addToAlbum(origin, id, { type: "media.asset", id: photo.assetId });
      addToAlbum(origin, id, { type: "media.asset", id: keeper.assetId }, 2);
      return id;
    });
    pass(origin, album);
    const before = replicaLogState(origin.vault).watermark;

    inCommit(origin, () =>
      origin.vault
        .prepare(
          "DELETE FROM core_collection_entry WHERE collection_id = ? AND target_id = ?"
        )
        .run(album, photo.assetId)
    );
    const outputs = pass(origin, album, before);
    expect(outputs.enter).toStrictEqual([]);
    expect(tablesOf(outputs.leave)).toStrictEqual([
      "core_collection_entry",
      "core_content_item",
      "core_content_representation",
      "media_asset",
    ]);
    // The keeper's rows are untouched, so nothing about them travels.
    expect(outputs.update).toStrictEqual([]);
    expect(readShareMembers(origin.vault, AUTHORITY).size).toBe(
      shareClosureMembers(origin.vault, albumClosure(origin, album)).size
    );
  });

  /*
   * PURGE REACHES EVERY CLAIMING GRANT THROUGH THE MEMBER-SET DIFF, and
   * through nothing else (#996, R10). `core_entity_revoke_on_purge` keys on a
   * grant's SUBJECT, so purging a shared MEMBER revokes nothing — two grants
   * over the same album both keep delivering, and the only thing that scrubs
   * the audience's copy is each grant's own `before ∖ after`. That is why the
   * origin needs no reverse "which grants claim this row" index: the answer is
   * per-grant by construction, and a second answerer could disagree with it.
   */
  test("a purged shared row leaves for EVERY grant whose member set held it", () => {
    const SECOND = "authority-album-second";
    const assetKey = (db: VaultDb, assetId: string): string =>
      memberKey(
        "media_asset",
        memberPrimaryKey(db.vault, "media_asset", { asset_id: assetId })
      );
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "purged");
    const keeper = seedPhoto(origin, originBoot, "kept");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Album");
      addToAlbum(origin, id, { type: "media.asset", id: photo.assetId });
      addToAlbum(origin, id, { type: "media.asset", id: keeper.assetId }, 2);
      return id;
    });
    pass(origin, album);
    pass(origin, album, undefined, SECOND);
    for (const authority of [AUTHORITY, SECOND])
      expect(
        readShareMembers(origin.vault, authority).has(
          assetKey(origin, photo.assetId)
        ),
        authority
      ).toBe(true);
    const before = replicaLogState(origin.vault).watermark;

    // A PURGE IS A DELETE OF THE SUPERTYPE ROW (`schema/entity.ts`).
    inCommit(origin, () =>
      origin.vault
        .prepare("DELETE FROM core_entity WHERE entity_id = ?")
        .run(photo.assetId)
    );
    // The grant is still live: the purge keyed on its subject, which is the
    // album, and the album is still here.
    for (const authority of [AUTHORITY, SECOND]) {
      const outputs = pass(origin, album, before, authority);
      expect(tablesOf(outputs.leave), authority).toContain("media_asset");
      expect(
        readShareMembers(origin.vault, authority).has(
          assetKey(origin, photo.assetId)
        ),
        authority
      ).toBe(false);
      // The keeper is untouched for both.
      expect(
        readShareMembers(origin.vault, authority).has(
          assetKey(origin, keeper.assetId)
        ),
        authority
      ).toBe(true);
    }
  });

  test("a member kept across a pass keeps its entered_seq; a re-entered one does not", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "seq");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Seq");
      addToAlbum(origin, id, { type: "media.asset", id: photo.assetId });
      return id;
    });
    pass(origin, album);
    const held = readShareMembers(origin.vault, AUTHORITY);
    const assetKey = [...held.keys()].find((key) =>
      key.startsWith("media_asset ")
    )!;
    const firstSeq = held.get(assetKey)!.enteredSeq;

    inCommit(origin, () =>
      origin.vault
        .prepare("UPDATE media_asset SET title = ? WHERE asset_id = ?")
        .run("Still here", photo.assetId)
    );
    pass(origin, album, replicaLogState(origin.vault).floor);
    expect(
      readShareMembers(origin.vault, AUTHORITY).get(assetKey)!.enteredSeq
    ).toBe(firstSeq);

    // Out of the album and back in: a NEW entry, and the seq says so.
    const entryId = origin.vault
      .prepare(
        "SELECT entry_id FROM core_collection_entry WHERE collection_id = ?"
      )
      .get(album) as { entry_id: string };
    inCommit(origin, () =>
      origin.vault
        .prepare("DELETE FROM core_collection_entry WHERE entry_id = ?")
        .run(entryId.entry_id)
    );
    pass(origin, album, replicaLogState(origin.vault).floor);
    inCommit(origin, () =>
      addToAlbum(origin, album, { type: "media.asset", id: photo.assetId }, 9)
    );
    pass(origin, album, replicaLogState(origin.vault).floor);
    expect(
      readShareMembers(origin.vault, AUTHORITY).get(assetKey)!.enteredSeq
    ).toBeGreaterThan(firstSeq);
  });

  test("a cursor below the retention floor RESENDS every member rather than re-bootstrapping", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "expired");
    const album = inCommit(origin, () => {
      const id = seedAlbum(origin, originBoot, "Expired");
      addToAlbum(origin, id, { type: "media.asset", id: photo.assetId });
      return id;
    });
    pass(origin, album);
    const stale = { epoch: replicaLogState(origin.vault).epoch, seq: -1 };
    const outputs = diffShareClosure(origin.vault, {
      authorityId: AUTHORITY,
      members: shareClosureMembers(origin.vault, albumClosure(origin, album)),
      since: stale,
    });
    expect(outputs.reason).toBe("resend");
    expect(outputs.enter).toHaveLength(
      readShareMembers(origin.vault, AUTHORITY).size
    );
    expect(outputs.update).toStrictEqual([]);
    expect(outputs.leave).toStrictEqual([]);
    // Every resent row is one the audience already holds under the same key,
    // so the resend is an upsert and never a scrub.
    for (const row of outputs.enter)
      expect(
        readShareMembers(origin.vault, AUTHORITY).has(
          memberKey(row.table, row.pk)
        )
      ).toBe(true);
  });
});
