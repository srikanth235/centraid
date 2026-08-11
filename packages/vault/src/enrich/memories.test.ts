// Memories v0 (issue #724 W7) — see memories.ts's header for the three
// kinds and the heuristics under test here.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerMediaCommands } from "../commands/media.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { recomputeDuplicateClusters } from "./clusters.js";
import { rebuildMemories } from "./memories.js";

/**
 * A distinct data URI per call. `media.add_asset` dedupes on the decoded
 * bytes' sha256 (issue #296) — reusing one image would silently adopt the
 * SAME asset instead of minting a new one, so every fixture asset gets its
 * own seed rather than cycling a small fixed pixel set (mint.ts's
 * `decodeDataUri` never validates image structure, so any distinct payload
 * is a legal, distinct "photograph" for this test's purposes).
 */
let seedCounter = 0;
function pixelDataUri(): string {
  seedCounter += 1;
  return `data:image/png;base64,${Buffer.from(`fixture-${seedCounter}`).toString("base64")}`;
}

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("memories", () => {
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
    seedCounter = 0;
  });

  function addAsset(input: Record<string, unknown> = {}): string {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: pixelDataUri(), ...input },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { asset_id: string } })
      .output.asset_id;
  }

  function setPlace(assetId: string, placeId: string): void {
    const outcome = gw.invoke(owner, {
      command: "media.set_asset_place",
      input: { asset_id: assetId, place_id: placeId },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
  }

  function insertPlace(
    placeId: string,
    name: string,
    kind: string | null = null
  ): void {
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, created_at) VALUES (?, ?, ?, datetime('now'))`
      )
      .run(placeId, name, kind);
  }

  function memberIds(memoryId: string): string[] {
    return (
      db.vault
        .prepare(
          `SELECT asset_id FROM media_memory_member WHERE memory_id = ? ORDER BY ordinal`
        )
        .all(memoryId) as { asset_id: string }[]
    ).map((row) => row.asset_id);
  }

  test("on-this-day groups the same month-day across distinct years", () => {
    const old1 = addAsset({ captured_at: "2024-07-16T10:00:00.000Z" });
    const old2 = addAsset({ captured_at: "2023-07-16T09:00:00.000Z" });
    // Different month-day: must not join the group.
    addAsset({ captured_at: "2024-07-17T10:00:00.000Z" });

    const result = rebuildMemories(db.vault, {
      now: "2026-07-16T00:00:00.000Z",
    });
    expect(result.onThisDay).toBe(1);

    const row = db.vault
      .prepare(
        `SELECT memory_id, day_key FROM media_memory WHERE kind = 'on-this-day'`
      )
      .get() as { memory_id: string; day_key: string };
    expect(row.day_key).toBe("07-16");
    expect(row.memory_id).toBe("otd:07-16");
    // Oldest capture first (capture order).
    expect(memberIds(row.memory_id)).toStrictEqual([old2, old1]);
  });

  test("a month-day with photos from only one year is not a memory", () => {
    addAsset({ captured_at: "2024-07-16T10:00:00.000Z" });
    addAsset({ captured_at: "2024-07-16T11:00:00.000Z" });
    const result = rebuildMemories(db.vault);
    expect(result.onThisDay).toBe(0);
  });

  test("an asset with no captured_at never enters on-this-day (honest absence)", () => {
    // No captured_at at all — mint the content, then null the captured_at
    // out explicitly (add_asset without capture fields already leaves it
    // NULL, but assert the schema shape holds rather than assuming it).
    const undated = addAsset();
    expect(
      (
        db.vault
          .prepare(`SELECT captured_at FROM media_asset WHERE asset_id = ?`)
          .get(undated) as { captured_at: string | null }
      ).captured_at
    ).toBeNull();
    addAsset({ captured_at: "2024-07-16T10:00:00.000Z" });
    addAsset({ captured_at: "2023-07-16T10:00:00.000Z" });
    rebuildMemories(db.vault);
    const memberAssetIds = (
      db.vault.prepare(`SELECT asset_id FROM media_memory_member`).all() as {
        asset_id: string;
      }[]
    ).map((row) => row.asset_id);
    expect(memberAssetIds).not.toContain(undated);
  });

  test("a date-line-crossing tz_offset_min shifts the capture-local day server-side", () => {
    // Raw UTC slice says Dec 31 2024; tzOffsetMin +60 puts the capture-local
    // day at Jan 1 2025 — must group with a Jan-1 asset from another year,
    // not with Dec-31 ones (mirrors apps/mobile's timeline-model.test.ts
    // "date-line-crossing" fixture, at the vault layer).
    const dateLine = addAsset({
      captured_at: "2024-12-31T23:00:00.000Z",
      tz_offset_min: 60,
    });
    const otherJan1 = addAsset({
      captured_at: "2023-01-01T05:00:00.000Z",
    });
    rebuildMemories(db.vault);
    const row = db.vault
      .prepare(`SELECT memory_id FROM media_memory WHERE kind = 'on-this-day'`)
      .get() as { memory_id: string } | undefined;
    expect(row?.memory_id).toBe("otd:01-01");
    expect(memberIds("otd:01-01").sort()).toStrictEqual(
      [dateLine, otherJan1].sort()
    );
  });

  test("byte-stability: rebuilding twice with the same clock produces identical rows", () => {
    addAsset({ captured_at: "2024-07-16T10:00:00.000Z" });
    addAsset({ captured_at: "2023-07-16T10:00:00.000Z" });
    const now = "2026-01-01T00:00:00.000Z";
    rebuildMemories(db.vault, { now });
    const first = db.vault
      .prepare(`SELECT * FROM media_memory ORDER BY memory_id`)
      .all();
    const firstMembers = db.vault
      .prepare(`SELECT * FROM media_memory_member ORDER BY memory_id, asset_id`)
      .all();
    rebuildMemories(db.vault, { now });
    const second = db.vault
      .prepare(`SELECT * FROM media_memory ORDER BY memory_id`)
      .all();
    const secondMembers = db.vault
      .prepare(`SELECT * FROM media_memory_member ORDER BY memory_id, asset_id`)
      .all();
    expect(second).toStrictEqual(first);
    expect(secondMembers).toStrictEqual(firstMembers);
  });

  test("drop and rebuild reproduces the same projection", () => {
    addAsset({ captured_at: "2024-07-16T10:00:00.000Z" });
    addAsset({ captured_at: "2023-07-16T10:00:00.000Z" });
    const now = "2026-01-01T00:00:00.000Z";
    rebuildMemories(db.vault, { now });
    const before = db.vault.prepare(`SELECT * FROM media_memory`).all();
    db.vault.exec("DELETE FROM media_memory_member");
    db.vault.exec("DELETE FROM media_memory");
    expect(
      (
        db.vault.prepare(`SELECT count(*) AS n FROM media_memory`).get() as {
          n: number;
        }
      ).n
    ).toBe(0);
    rebuildMemories(db.vault, { now });
    const after = db.vault.prepare(`SELECT * FROM media_memory`).all();
    expect(after).toStrictEqual(before);
  });

  test("trip detection on a synthetic itinerary: away days within the gap merge, a single day out does not become a trip", () => {
    insertPlace("home", "Home", "home");
    insertPlace("paris", "Paris");
    insertPlace("day-trip-town", "Nearby Town");

    // Home baseline before and after the trip.
    const home1 = addAsset({ captured_at: "2026-01-01T10:00:00.000Z" });
    setPlace(home1, "home");

    // A 4-day Paris trip, Jan 5 - Jan 8, with Jan 7 a photo-less gap day
    // (within TRIP_GAP_DAYS) that should NOT split the trip.
    const paris1 = addAsset({ captured_at: "2026-01-05T09:00:00.000Z" });
    setPlace(paris1, "paris");
    const paris2 = addAsset({ captured_at: "2026-01-06T09:00:00.000Z" });
    setPlace(paris2, "paris");
    const paris3 = addAsset({ captured_at: "2026-01-08T09:00:00.000Z" });
    setPlace(paris3, "paris");

    const home2 = addAsset({ captured_at: "2026-01-12T10:00:00.000Z" });
    setPlace(home2, "home");

    // A single day out to a nearby town — must NOT surface as a trip.
    const dayTrip = addAsset({
      captured_at: "2026-02-01T10:00:00.000Z",
    });
    setPlace(dayTrip, "day-trip-town");

    const result = rebuildMemories(db.vault);
    expect(result.trips).toBe(1);

    const trip = db.vault
      .prepare(
        `SELECT memory_id, place_id, title_hint FROM media_memory WHERE kind = 'trip'`
      )
      .get() as { memory_id: string; place_id: string; title_hint: string };
    expect(trip.memory_id).toBe("trip:2026-01-05");
    expect(trip.place_id).toBe("paris");
    expect(trip.title_hint).toBe("3-day trip");
    // Members span the whole date range inclusive (Jan 5 - Jan 8), so all
    // three Paris photographs belong, and neither home baseline nor the
    // day-trip photograph do.
    expect(memberIds(trip.memory_id).sort()).toStrictEqual(
      [paris1, paris2, paris3].sort()
    );
  });

  test("no home place recorded means no trip can be detected", () => {
    insertPlace("somewhere", "Somewhere");
    const a = addAsset({ captured_at: "2026-01-05T09:00:00.000Z" });
    setPlace(a, "somewhere");
    const b = addAsset({ captured_at: "2026-01-06T09:00:00.000Z" });
    setPlace(b, "somewhere");
    const result = rebuildMemories(db.vault);
    expect(result.trips).toBe(0);
  });

  test("similar moments union phash clusters and capture groups, and drop singletons", () => {
    const a = addAsset({
      phash: "ff00ff00",
      captured_at: "2026-01-01T00:00:00.000Z",
    });
    const b = addAsset({
      phash: "ff00ff01",
      captured_at: "2026-01-01T00:00:01.000Z",
    });
    // Recompute clusters so media_asset_phash.cluster_id is populated —
    // rebuildMemories reads that column, it does not compute it.
    recomputeDuplicateClusters(db.vault);

    // A capture-group pair (Live Photo still + motion) unrelated to the
    // phash cluster above.
    const still = addAsset({
      capture_group_id: "live:1",
      captured_at: "2026-02-01T00:00:00.000Z",
    });
    const motion = addAsset({
      capture_group_id: "live:1",
      captured_at: "2026-02-01T00:00:01.000Z",
    });

    // An asset with a phash that clusters with nothing (singleton) — must
    // not become its own "similar" memory.
    addAsset({ phash: "00000000", captured_at: "2026-03-01T00:00:00.000Z" });
    recomputeDuplicateClusters(db.vault);

    const result = rebuildMemories(db.vault);
    expect(result.similar).toBe(2);
    const groups = db.vault
      .prepare(
        `SELECT memory_id FROM media_memory WHERE kind = 'similar' ORDER BY memory_id`
      )
      .all() as { memory_id: string }[];
    const allMembers = groups.flatMap((g) => memberIds(g.memory_id));
    expect(allMembers.sort()).toStrictEqual([a, b, motion, still].sort());
  });

  test("an asset with no captured_at can still enter a similar-moment group", () => {
    const withDate = addAsset({
      capture_group_id: "live:2",
      captured_at: "2026-01-01T00:00:00.000Z",
    });
    const undated = addAsset({ capture_group_id: "live:2" });
    const result = rebuildMemories(db.vault);
    expect(result.similar).toBe(1);
    const row = db.vault
      .prepare(`SELECT memory_id FROM media_memory WHERE kind = 'similar'`)
      .get() as { memory_id: string };
    expect(memberIds(row.memory_id).sort()).toStrictEqual(
      [withDate, undated].sort()
    );
  });
});
