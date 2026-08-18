/*
 * `media.set_place_gazetteer` (#816) — the derived half of a place's name.
 *
 * The invariant this file exists for is member authority IN STORAGE: whatever
 * the opt-in automation finds, the row's `name` and `kind` are the member's and
 * come out of the transaction exactly as they went in. The handler's half of the
 * same rule is `packages/model-runtime/automation-handlers/place-names.test.ts`.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerMediaGazetteerCommands } from "./media-gazetteer.js";

const SOURCE = "geonames-cities15000";
const SNAPSHOT = "2017-02-27";

let db: VaultDb;
let gw: Gateway;
let owner: Credential;

interface PlaceRow {
  name: string;
  kind: string | null;
  address_json: string | null;
}

describe("media.set_place_gazetteer", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerMediaGazetteerCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command: "media.set_place_gazetteer",
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  /** A place row, minted directly: this command is not how places are created. */
  function seedPlace(
    placeId: string,
    fields: { name?: string; kind?: string | null; addressJson?: string } = {}
  ): void {
    db.vault
      .prepare(
        `INSERT INTO core_place
           (place_id, name, kind, geo_lat, geo_lng, address_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        placeId,
        fields.name ?? "39.16820, -120.14290",
        fields.kind ?? null,
        39.1682,
        -120.1429,
        fields.addressJson ?? null,
        "2026-08-17T00:00:00.000Z"
      );
  }

  function readPlace(placeId: string): PlaceRow {
    return db.vault
      .prepare(
        "SELECT name, kind, address_json FROM core_place WHERE place_id = ?"
      )
      .get(placeId) as unknown as PlaceRow;
  }

  function gazetteerOf(placeId: string): Record<string, unknown> {
    const raw = readPlace(placeId).address_json;
    expect(raw).not.toBeNull();
    return (JSON.parse(raw!) as { gazetteer: Record<string, unknown> })
      .gazetteer;
  }

  test("records the settlement inside address_json", () => {
    seedPlace("p1");

    const outcome = invoke({
      place_id: "p1",
      name: "Truckee, CA",
      admin: "CA",
      country: "US",
      distance_km: 18.1,
      source: SOURCE,
      snapshot: SNAPSHOT,
    });

    expect(outcome.status).toBe("executed");
    expect((outcome as { output: unknown }).output).toStrictEqual({
      place_id: "p1",
      matched: true,
      name: "Truckee, CA",
    });
    const gazetteer = gazetteerOf("p1");
    expect(gazetteer).toMatchObject({
      name: "Truckee, CA",
      admin: "CA",
      country: "US",
      distance_km: 18.1,
      source: SOURCE,
      snapshot: SNAPSHOT,
    });
    expect(gazetteer.checked_at).toBeTypeOf("string");
  });

  test("the member's name and kind survive the write untouched", () => {
    seedPlace("p1", { name: "Grandma's house", kind: "home" });

    expect(
      invoke({ place_id: "p1", name: "Truckee, CA", source: SOURCE }).status
    ).toBe("executed");

    const row = readPlace("p1");
    expect(row.name).toBe("Grandma's house");
    expect(row.kind).toBe("home");
    // Both claims are true about the point, and both are readable. The ladder
    // (place-phrase.ts) prefers the member's for display; nothing deleted the
    // machine's, and nothing overwrote the member's.
    expect(gazetteerOf("p1").name).toBe("Truckee, CA");
  });

  test("every other key in address_json is preserved", () => {
    seedPlace("p1", {
      addressJson: JSON.stringify({
        street: "10 Somewhere Road",
        postcode: "96161",
        gazetteer: { name: "Stale, XX", checked_at: "2020-01-01" },
      }),
    });

    invoke({ place_id: "p1", name: "Truckee, CA", source: SOURCE });

    const parsed = JSON.parse(readPlace("p1").address_json!) as Record<
      string,
      unknown
    >;
    expect(parsed.street).toBe("10 Somewhere Road");
    expect(parsed.postcode).toBe("96161");
    // Only this key is replaced, and wholly — a stale record does not merge
    // with a fresh one field by field.
    expect(parsed.gazetteer).toMatchObject({ name: "Truckee, CA" });
    expect(parsed.gazetteer).not.toHaveProperty("checked_at", "2020-01-01");
  });

  test("an omitted name records a none-marker, not an empty name", () => {
    seedPlace("p1");

    const outcome = invoke({
      place_id: "p1",
      source: SOURCE,
      snapshot: SNAPSHOT,
    });

    expect(outcome.status).toBe("executed");
    expect((outcome as { output: unknown }).output).toStrictEqual({
      place_id: "p1",
      matched: false,
    });
    const gazetteer = gazetteerOf("p1");
    expect(gazetteer.none).toBe(true);
    expect(gazetteer).not.toHaveProperty("name");
    expect(gazetteer.snapshot).toBe(SNAPSHOT);
    expect(gazetteer.checked_at).toBeTypeOf("string");
  });

  test("a later hit replaces an earlier none-marker", () => {
    seedPlace("p1");

    invoke({ place_id: "p1", source: SOURCE });
    invoke({ place_id: "p1", name: "Truckee, CA", source: SOURCE });

    const gazetteer = gazetteerOf("p1");
    expect(gazetteer.name).toBe("Truckee, CA");
    expect(gazetteer).not.toHaveProperty("none");
  });

  test("an absent admin or country is left out rather than stored blank", () => {
    seedPlace("p1");

    invoke({ place_id: "p1", name: "Kyoto", admin: "", source: SOURCE });

    const gazetteer = gazetteerOf("p1");
    expect(gazetteer).not.toHaveProperty("admin");
    expect(gazetteer).not.toHaveProperty("country");
    expect(gazetteer.name).toBe("Kyoto");
  });

  test("a place that does not exist is refused", () => {
    const outcome = invoke({
      place_id: "nope",
      name: "Truckee, CA",
      source: SOURCE,
    });

    expect(outcome.status).not.toBe("executed");
  });

  test("an unknown source is refused", () => {
    seedPlace("p1");

    const outcome = invoke({
      place_id: "p1",
      name: "Truckee, CA",
      source: "some-geocoding-api",
    });

    expect(outcome.status).not.toBe("executed");
    expect(readPlace("p1").address_json).toBeNull();
  });

  test("a distance no neighbourhood claim could survive is refused", () => {
    seedPlace("p1");

    const outcome = invoke({
      place_id: "p1",
      name: "Truckee, CA",
      distance_km: 5000,
      source: SOURCE,
    });

    expect(outcome.status).not.toBe("executed");
    expect(readPlace("p1").address_json).toBeNull();
  });

  test("the write is idempotent apart from its timestamp", () => {
    seedPlace("p1");
    const input = {
      place_id: "p1",
      name: "Truckee, CA",
      admin: "CA",
      country: "US",
      distance_km: 18.1,
      source: SOURCE,
      snapshot: SNAPSHOT,
    };

    invoke(input);
    const first = gazetteerOf("p1");
    invoke(input);
    const second = gazetteerOf("p1");

    expect({ ...second, checked_at: "" }).toStrictEqual({
      ...first,
      checked_at: "",
    });
  });
});
