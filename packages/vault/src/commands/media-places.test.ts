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
/** A second, differently coloured 1×1 PNG — content dedupe adopts identical
 *  bytes onto the existing asset, so a test that needs two assets needs two
 *  payloads. */
const OTHER_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC";
let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("media: places", () => {
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
      purpose: "dpv:ServiceProvision",
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

  function exifJpegAt(
    latDeg: number,
    latRef: "N" | "S",
    lonDeg: number,
    lonRef: "E" | "W",
    padding = 0
  ): Buffer {
    const entrySize = 12;
    const ifd0At = 8;
    const gpsIfdAt = ifd0At + 2 + entrySize + 4;
    const dataAt = gpsIfdAt + 2 + 4 * entrySize + 4;
    const latAt = dataAt;
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
    ) => {
      tiff.writeUInt16LE(tag, at);
      tiff.writeUInt16LE(type, at + 2);
      tiff.writeUInt32LE(count, at + 4);
      if (inlineAscii === undefined) tiff.writeUInt32LE(value, at + 8);
      else tiff.write(inlineAscii, at + 8, "latin1");
    };
    tiff.writeUInt16LE(1, ifd0At);
    entry(ifd0At + 2, 0x8825, 4, 1, gpsIfdAt);
    tiff.writeUInt16LE(4, gpsIfdAt);
    entry(gpsIfdAt + 2, 0x0001, 2, 2, 0, `${latRef}\0`);
    entry(gpsIfdAt + 2 + entrySize, 0x0002, 5, 3, latAt);
    entry(gpsIfdAt + 2 + 2 * entrySize, 0x0003, 2, 2, 0, `${lonRef}\0`);
    entry(gpsIfdAt + 2 + 3 * entrySize, 0x0004, 5, 3, lonAt);
    const rational = (at: number, values: [number, number][]) =>
      values.forEach(([num, den], i) => {
        tiff.writeUInt32LE(num, at + i * 8);
        tiff.writeUInt32LE(den, at + i * 8 + 4);
      });
    rational(latAt, [
      [latDeg, 1],
      [0, 1],
      [0, 1],
    ]);
    rational(lonAt, [
      [lonDeg, 1],
      [0, 1],
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
      Buffer.alloc(padding, padding % 251 || 1),
    ]);
  }

  function stageAndAdd(jpeg: Buffer) {
    const staged = gw.stageBlob(owner, { bytes: jpeg, filename: "photo.jpg" });
    return addAsset({ staged_sha: staged.sha256 });
  }

  test("add_asset with EXIF GPS finds-or-creates a core.place and links it", () => {
    const { asset_id } = stageAndAdd(exifJpegAt(37, "N", 122, "W"));
    const asset = db.vault
      .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
      .get(asset_id) as { place_id: string | null };
    expect(asset.place_id).not.toBeNull();
    const place = db.vault
      .prepare("SELECT geo_lat, geo_lng FROM core_place WHERE place_id = ?")
      .get(asset.place_id) as { geo_lat: number; geo_lng: number };
    expect(place.geo_lat).toBeCloseTo(37, 3);
    expect(place.geo_lng).toBeCloseTo(-122, 3);
  });

  test("two photos at the same rounded coordinates share one core.place", () => {
    const first = stageAndAdd(exifJpegAt(37, "N", 122, "W", 1));
    const second = stageAndAdd(exifJpegAt(37, "N", 122, "W", 2));
    const places = db.vault
      .prepare(
        "SELECT place_id FROM media_media_asset WHERE asset_id IN (?, ?)"
      )
      .all(first.asset_id, second.asset_id) as { place_id: string }[];
    expect(places[0]?.place_id).toBe(places[1]?.place_id);
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM core_place").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  test("a photo at a different location gets a different core.place", () => {
    const first = stageAndAdd(exifJpegAt(37, "N", 122, "W", 1));
    const second = stageAndAdd(exifJpegAt(10, "N", 20, "E", 2));
    const rows = db.vault
      .prepare(
        "SELECT place_id FROM media_media_asset WHERE asset_id IN (?, ?)"
      )
      .all(first.asset_id, second.asset_id) as { place_id: string }[];
    expect(rows[0]?.place_id).not.toBe(rows[1]?.place_id);
  });

  test("a photo with no GPS gets no place", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    const asset = db.vault
      .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
      .get(asset_id) as { place_id: string | null };
    expect(asset.place_id).toBeNull();
  });

  test("media.set_asset_place sets and clears an asset location explicitly", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    const placeId = "test-place-1";
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, created_at) VALUES (?, 'Home', 'home', 12.9, 77.6, datetime('now'))`
      )
      .run(placeId);
    expect(
      invoke("media.set_asset_place", { asset_id, place_id: placeId }).status
    ).toBe("executed");
    expect(
      (
        db.vault
          .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
          .get(asset_id) as { place_id: string }
      ).place_id
    ).toBe(placeId);
    expect(invoke("media.set_asset_place", { asset_id }).status).toBe(
      "executed"
    );
    expect(
      (
        db.vault
          .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
          .get(asset_id) as { place_id: string | null }
      ).place_id
    ).toBeNull();
  });

  test("media.set_asset_place refuses an unknown place id", () => {
    const { asset_id } = addAsset({ data_uri: PIXEL });
    expect(
      invoke("media.set_asset_place", { asset_id, place_id: "nope" }).status
    ).not.toBe("executed");
  });

  // The inline door carries no spool metadata, so before these an asset added
  // as a `data_uri` could never have a place — which is why a fully seeded
  // vault still showed an empty Places shelf.
  test("an asserted coordinate places an inline asset", () => {
    const { asset_id } = addAsset({
      data_uri: PIXEL,
      latitude: 38.9542,
      longitude: -120.1094,
    });
    const row = db.vault
      .prepare(
        `SELECT p.geo_lat AS lat, p.geo_lng AS lng FROM media_media_asset a
           JOIN core_place p ON p.place_id = a.place_id
          WHERE a.asset_id = ?`
      )
      .get(asset_id) as { lat: number; lng: number } | undefined;
    // Field by field: a `node:sqlite` row is a null-prototype object, so a
    // whole-object comparison fails on the prototype while reporting "no
    // visual difference" — which is a worse test AND a worse failure message.
    expect(row?.lat).toBe(38.9542);
    expect(row?.lng).toBe(-120.1094);
  });

  test("two assets a few metres apart share one place", () => {
    const first = addAsset({
      data_uri: PIXEL,
      latitude: 39.0021,
      longitude: -120.1131,
    });
    // Same spot to 4dp — the ~11m identity rung — via a different 6dp pair,
    // which is what a second shutter click at one overlook actually looks
    // like. A per-photo place row would make the shelf a list of duplicates.
    // Distinct BYTES matter here: identical content is adopted onto the first
    // asset, and one asset cannot demonstrate two assets sharing anything.
    const second = addAsset({
      data_uri: OTHER_PIXEL,
      latitude: 39.00212,
      longitude: -120.11307,
    });
    const rows = db.vault
      .prepare(
        "SELECT place_id FROM media_media_asset WHERE asset_id IN (?, ?)"
      )
      .all(first.asset_id, second.asset_id) as { place_id: string }[];
    expect(rows[0]?.place_id).toBe(rows[1]?.place_id);
  });

  // A vault holds named places from the rest of the product — a home, an
  // office, a venue on an event. A photograph taken at one of them belongs to
  // it, and the alternative is that a member who carefully named where they
  // live still gets a shelf of coordinate strings.
  test("a photograph adopts a place the member already named nearby", () => {
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, created_at)
         VALUES ('home', 'Home', 'home', 37.4419, -122.143, datetime('now'))`
      )
      .run();
    // ~90m up the garden: a different coordinate, the same place.
    const { asset_id } = addAsset({
      data_uri: PIXEL,
      latitude: 37.4427,
      longitude: -122.1432,
    });
    const row = db.vault
      .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
      .get(asset_id) as { place_id: string };
    expect(row.place_id).toBe("home");
    // And no second row was minted beside it.
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM core_place").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  test("a coordinate-labelled place is not a name, so it is not adopted", () => {
    // The label this command mints itself. Adopting one would smear a
    // meaningless string across a neighbourhood and hide the row from the
    // geocoding sweep that is looking for exactly this shape.
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, created_at)
         VALUES ('coord', '37.4419, -122.1430', NULL, 37.4419, -122.143, datetime('now'))`
      )
      .run();
    const { asset_id } = addAsset({
      data_uri: PIXEL,
      latitude: 37.4427,
      longitude: -122.1432,
    });
    const row = db.vault
      .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
      .get(asset_id) as { place_id: string };
    expect(row.place_id).not.toBe("coord");
  });

  test("a named place two kilometres away is a different place", () => {
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, created_at)
         VALUES ('home', 'Home', 'home', 37.4419, -122.143, datetime('now'))`
      )
      .run();
    const { asset_id } = addAsset({
      data_uri: PIXEL,
      latitude: 37.46,
      longitude: -122.143,
    });
    const row = db.vault
      .prepare("SELECT place_id FROM media_media_asset WHERE asset_id = ?")
      .get(asset_id) as { place_id: string };
    expect(row.place_id).not.toBe("home");
  });

  test("half a coordinate is refused, not silently dropped", () => {
    expect(
      invoke("media.add_asset", { data_uri: PIXEL, latitude: 38.9542 }).status
    ).not.toBe("executed");
    expect(
      invoke("media.add_asset", { data_uri: PIXEL, longitude: -120.1094 })
        .status
    ).not.toBe("executed");
  });
});
