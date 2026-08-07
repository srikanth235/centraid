// The photo-library import, end to end on the staging spine (issue #721 A1):
// a Takeout zip stages as one reviewable batch, publishes into
// media_media_asset through media.add_asset's own primitives, and is
// re-importable because the queue IS the database.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Identity } from "../gateway/types.js";
import { PUBLISHERS } from "./publishers.js";
import { stageFile } from "./stage-file.js";
import { publishBatch } from "./staging.js";
import { writeZipEntries } from "./zip.js";

/**
 * A JPEG with nothing in it but a unique comment — enough for the sniffer to
 * call it `image/jpeg`, and enough for two of them to hash differently.
 */
function jpeg(marker: string): Buffer {
  const text = Buffer.from(marker, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
    length,
    text,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A minimal ISO-BMFF header that sniffs as QuickTime — the motion half. */
function quicktime(marker: string): Buffer {
  const text = Buffer.from(marker.padEnd(8, " "), "utf8").subarray(0, 8);
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x10]),
    Buffer.from("ftypqt  ", "latin1"),
    text,
  ]);
}

/**
 * A JPEG whose APP1/EXIF block carries DateTimeOriginal and GPS 37°30'N
 * 122°15'W. Offsets are computed, not hand-counted, so the fixture cannot
 * drift out of agreement with the parser it exercises.
 */
function exifJpeg(dateTimeOriginal: string): Buffer {
  const entrySize = 12;
  const ifd0At = 8;
  const exifIfdAt = ifd0At + 2 + 2 * entrySize + 4;
  const gpsIfdAt = exifIfdAt + 2 + 1 * entrySize + 4;
  const dataAt = gpsIfdAt + 2 + 4 * entrySize + 4;
  const dto = `${dateTimeOriginal}\0`;
  const dtoAt = dataAt;
  const latAt = dtoAt + dto.length;
  const lonAt = latAt + 24;
  const tiff = Buffer.alloc(lonAt + 24);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(ifd0At, 4);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
    inlineAscii?: string
  ): void => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (inlineAscii === undefined) tiff.writeUInt32LE(value, at + 8);
    else tiff.write(inlineAscii, at + 8, "latin1");
  };
  tiff.writeUInt16LE(2, ifd0At);
  entry(ifd0At + 2, 0x8769, 4, 1, exifIfdAt);
  entry(ifd0At + 2 + entrySize, 0x8825, 4, 1, gpsIfdAt);
  tiff.writeUInt16LE(1, exifIfdAt);
  entry(exifIfdAt + 2, 0x9003, 2, dto.length, dtoAt);
  tiff.write(dto, dtoAt, "latin1");
  tiff.writeUInt16LE(4, gpsIfdAt);
  entry(gpsIfdAt + 2, 0x0001, 2, 2, 0, "N\0");
  entry(gpsIfdAt + 2 + entrySize, 0x0002, 5, 3, latAt);
  entry(gpsIfdAt + 2 + 2 * entrySize, 0x0003, 2, 2, 0, "W\0");
  entry(gpsIfdAt + 2 + 3 * entrySize, 0x0004, 5, 3, lonAt);
  const rational = (at: number, values: [number, number][]): void => {
    values.forEach(([num, den], i) => {
      tiff.writeUInt32LE(num, at + i * 8);
      tiff.writeUInt32LE(den, at + i * 8 + 4);
    });
  };
  rational(latAt, [
    [37, 1],
    [30, 1],
    [0, 1],
  ]);
  rational(lonAt, [
    [122, 1],
    [15, 1],
    [0, 1],
  ]);
  const exifBody = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exifBody,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function json(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

/** The archive most of these tests import. */
function takeoutZip(): Buffer {
  return writeZipEntries([
    {
      name: "Takeout/Google Photos/Elba 2019/metadata.json",
      data: json({ title: "Elba, summer" }),
    },
    {
      name: "Takeout/Google Photos/Elba 2019/IMG_1.jpg",
      data: jpeg("elba-still"),
    },
    {
      name: "Takeout/Google Photos/Elba 2019/IMG_1.jpg.json",
      data: json({
        photoTakenTime: { timestamp: "1561234567" },
        geoData: { latitude: 42.7667, longitude: 10.3 },
        description: "Ferry to Elba",
        favorited: true,
      }),
    },
    {
      name: "Takeout/Google Photos/Elba 2019/IMG_1.MOV",
      data: quicktime("elbamov"),
    },
    {
      name: "Takeout/Google Photos/Photos from 2019/IMG_2.jpg",
      data: jpeg("undated"),
    },
    {
      name: "Takeout/Google Photos/Photos from 2019/IMG_2.jpg.json",
      data: json({ photoTakenTime: { timestamp: "0" } }),
    },
    {
      name: "Takeout/archive_browser.html",
      data: Buffer.from("<html>Takeout</html>", "utf8"),
    },
  ]);
}

describe("takeout photo import", () => {
  let db: VaultDb;
  let owner: Identity;

  beforeEach(() => {
    db = openVaultDb();
    const boot: BootstrapResult = bootstrapVault(db, { ownerName: "Priya" });
    owner = {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      mayAct: true,
    };
  });

  const assets = (): Record<string, unknown>[] =>
    db.vault
      .prepare(
        `SELECT a.asset_id, a.kind, a.captured_at, a.capture_group_id, a.favorite,
                a.place_id, c.title, c.sha256
           FROM media_media_asset a JOIN core_content_item c ON c.content_id = a.content_id
          ORDER BY c.title`
      )
      .all() as Record<string, unknown>[];

  test("one zip, one batch: photos route as media, the rest still reports", () => {
    const staged = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    expect(staged.kind).toBe("file.takeout");
    // Three media entries; the sidecars and metadata.json were consumed as
    // metadata, and only the genuinely unimportable entry is reported.
    expect(staged.staged.create).toBe(3);
    expect(staged.total).toBe(3);
    expect(staged.unrouted).toStrictEqual(["Takeout/archive_browser.html"]);

    const published = publishBatch(db, owner, staged.batchId, PUBLISHERS);
    expect(published.failed).toStrictEqual([]);
    expect(published.created).toBe(3);

    const rows = assets();
    expect(rows).toHaveLength(3);
    const still = rows.find((r) => r.title === "Ferry to Elba")!;
    const motion = rows.find((r) => r.title === "IMG_1.MOV")!;
    const undated = rows.find((r) => r.title === "IMG_2.jpg")!;

    // Sidecar time, caption, star and place all landed on the still.
    expect(still.captured_at).toBe("2019-06-22T20:16:07.000Z");
    expect(still.kind).toBe("photo");
    expect(still.favorite).toBe(1);
    expect(still.place_id).not.toBeNull();
    // The favorite column mirrors the canonical starred tag (issue #441 A2.1).
    const starred = db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
          WHERE t.target_type = 'core.content_item' AND c.notation = 'starred'`
      )
      .get() as { n: number };
    expect(starred.n).toBe(1);

    // Live Photo: the still and its motion part share one capture group.
    expect(motion.kind).toBe("video");
    expect(motion.capture_group_id).toBe(still.capture_group_id);
    expect(still.capture_group_id).toMatch(/^takeout:/u);

    // HONEST ABSENCE: "0" is not a capture time, so this one is undated.
    expect(undated.captured_at).toBeNull();

    // The album folder became an album; the year folder did not.
    const album = db.vault
      .prepare(
        "SELECT collection_id, name, cover_content_id FROM core_collection"
      )
      .all() as {
      collection_id: string;
      name: string;
      cover_content_id: string | null;
    }[];
    expect(album.map((a) => a.name)).toStrictEqual(["Elba, summer"]);
    expect(album[0]!.cover_content_id).not.toBeNull();
    const members = db.vault
      .prepare(
        `SELECT target_id FROM core_collection_entry
          WHERE collection_id = ? AND target_type = 'media.media_asset'`
      )
      .all(album[0]!.collection_id) as { target_id: string }[];
    expect(members.map((m) => m.target_id).sort()).toStrictEqual(
      [still.asset_id as string, motion.asset_id as string].sort()
    );

    const prov = db.journal
      .prepare(
        `SELECT count(*) AS n FROM consent_provenance
          WHERE prov_activity = 'import.takeout' AND entity_type = 'media.media_asset'
            AND agent_kind = 'import'`
      )
      .get() as { n: number };
    expect(prov.n).toBe(3);
  });

  test("sidecar time beats EXIF; EXIF fills the gap when no sidecar does", () => {
    const zip = writeZipEntries([
      {
        name: "Photos/with-sidecar.jpg",
        data: exifJpeg("2020:01:02 03:04:05"),
      },
      {
        name: "Photos/with-sidecar.jpg.json",
        data: json({ photoTakenTime: { timestamp: "1561234567" } }),
      },
      { name: "Photos/exif-only.jpg", data: exifJpeg("2021:11:12 13:14:15") },
    ]);
    const staged = stageFile(db, owner, { filename: "takeout.zip", data: zip });
    expect(publishBatch(db, owner, staged.batchId, PUBLISHERS).created).toBe(2);
    const times = Object.fromEntries(
      assets().map((row) => [row.title, row.captured_at])
    );
    expect(times["with-sidecar.jpg"]).toBe("2019-06-22T20:16:07.000Z");
    // Zoneless local, exactly as the camera wrote it — the EXIF contract.
    expect(times["exif-only.jpg"]).toBe("2021-11-12T13:14:15");
  });

  test("re-importing the same archive skips every row", () => {
    const first = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    publishBatch(db, owner, first.batchId, PUBLISHERS);

    const second = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    expect(second.staged).toMatchObject({ create: 0, update: 0, skip: 3 });
    const republished = publishBatch(db, owner, second.batchId, PUBLISHERS);
    expect(republished).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    expect(assets()).toHaveLength(3);
  });

  test("a row that failed to publish is created by the next import", () => {
    const first = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    // Simulate the interruption: one photo's staged bytes are gone when
    // publish reaches its row, exactly as a killed process would leave it.
    const victim = db.vault
      .prepare(
        `SELECT external_id, payload_json FROM sync_import_row
          WHERE batch_id = ? AND external_id LIKE '%IMG_2.jpg'`
      )
      .get(first.batchId) as { external_id: string; payload_json: string };
    const sha = (JSON.parse(victim.payload_json) as { stagedSha: string })
      .stagedSha;
    db.vault.prepare("DELETE FROM blob_staging WHERE sha256 = ?").run(sha);
    db.blobs.deleteLocalSync(sha);

    const published = publishBatch(db, owner, first.batchId, PUBLISHERS);
    expect(published.created).toBe(2);
    expect(published.failed.map((f) => f.externalId)).toStrictEqual([
      victim.external_id,
    ]);

    // The rest of the batch landed, so the next import only has the hole to
    // fill: resumability is structural, not a retry loop.
    const second = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    expect(second.staged).toMatchObject({ create: 1, skip: 2 });
    expect(publishBatch(db, owner, second.batchId, PUBLISHERS).created).toBe(1);
    expect(assets()).toHaveLength(3);
  });

  test("a photo already in the vault by bytes skips, whatever the archive calls it", () => {
    const same = jpeg("one-and-the-same");
    const first = stageFile(db, owner, {
      filename: "takeout-001.zip",
      data: writeZipEntries([{ name: "Photos/A/IMG_9.jpg", data: same }]),
    });
    publishBatch(db, owner, first.batchId, PUBLISHERS);

    // Different archive, different connection, different path — same bytes.
    const second = stageFile(db, owner, {
      filename: "takeout-002.zip",
      data: writeZipEntries([{ name: "Photos/B/renamed.jpg", data: same }]),
    });
    expect(second.staged).toMatchObject({ create: 0, skip: 1 });
    publishBatch(db, owner, second.batchId, PUBLISHERS);
    expect(assets()).toHaveLength(1);
  });

  test("duplicate bytes inside ONE archive become one asset", () => {
    const same = jpeg("twice-over");
    const staged = stageFile(db, owner, {
      filename: "takeout.zip",
      data: writeZipEntries([
        { name: "Photos/A/IMG_9.jpg", data: same },
        { name: "Photos/A/IMG_9(1).jpg", data: same },
      ]),
    });
    // Neither was in the vault when the batch was dispositioned, so both
    // staged as creates; the second adopts the first at publish.
    expect(staged.staged.create).toBe(2);
    const published = publishBatch(db, owner, staged.batchId, PUBLISHERS);
    expect(published.failed).toStrictEqual([]);
    expect(assets()).toHaveLength(1);
  });

  test("a single dropped photo is a one-photo import", () => {
    const staged = stageFile(db, owner, {
      filename: "sunset.jpg",
      data: exifJpeg("2022:07:04 19:30:00"),
    });
    expect(staged.kind).toBe("file.jpg");
    expect(staged.total).toBe(1);
    expect(publishBatch(db, owner, staged.batchId, PUBLISHERS).created).toBe(1);
    const rows = assets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "sunset.jpg",
      captured_at: "2022-07-04T19:30:00",
      capture_group_id: null,
    });
  });

  test("a media extension is a claim; the bytes settle it", () => {
    // Bare drop: not a photograph, so it is not routed as one.
    expect(() =>
      stageFile(db, owner, { filename: "photo.heic", data: "not really" })
    ).toThrow(/no importer/u);
    // Inside an archive the same file is reported, never invented into a row.
    const staged = stageFile(db, owner, {
      filename: "takeout.zip",
      data: writeZipEntries([
        { name: "Photos/A/real.jpg", data: jpeg("real") },
        { name: "Photos/A/liar.heic", data: Buffer.from("not really", "utf8") },
      ]),
    });
    expect(staged.total).toBe(1);
    expect(staged.unrouted).toStrictEqual(["Photos/A/liar.heic"]);
  });

  test("media.location = strip keeps SIDECAR coordinates out too", () => {
    db.vault
      .prepare("UPDATE core_vault SET settings_json = ?")
      .run(JSON.stringify({ media: { location: "strip" } }));
    const staged = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    publishBatch(db, owner, staged.batchId, PUBLISHERS);
    expect(assets().every((row) => row.place_id === null)).toBe(true);
    const places = db.vault
      .prepare("SELECT count(*) AS n FROM core_place")
      .get() as { n: number };
    expect(places.n).toBe(0);
  });

  test("an edited sidecar stages as an update, and the review applies it", () => {
    const first = stageFile(db, owner, {
      filename: "takeout.zip",
      data: takeoutZip(),
    });
    publishBatch(db, owner, first.batchId, PUBLISHERS);

    // The owner captions the undated photo in Google Photos and re-exports.
    const edited = writeZipEntries([
      {
        name: "Takeout/Google Photos/Photos from 2019/IMG_2.jpg",
        data: jpeg("undated"),
      },
      {
        name: "Takeout/Google Photos/Photos from 2019/IMG_2.jpg.json",
        data: json({
          photoTakenTime: { timestamp: "0" },
          description: "The one nobody dated",
        }),
      },
    ]);
    const second = stageFile(db, owner, {
      filename: "takeout.zip",
      data: edited,
    });
    expect(second.staged).toMatchObject({ create: 0, update: 1 });
    expect(publishBatch(db, owner, second.batchId, PUBLISHERS).updated).toBe(1);
    const captioned = assets().find((r) => r.title === "The one nobody dated");
    expect(captioned).toBeDefined();
    // A sidecar that still knows no capture time may not invent one.
    expect(captioned!.captured_at).toBeNull();
  });
});
