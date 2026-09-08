import { describe, expect, it } from "vitest";

import {
  applyRowSql,
  decodeWireRow,
  decodeWireValue,
  deleteRowSql,
  encodeWireRow,
  encodeWireValue,
} from "./row-json.js";

describe(encodeWireValue, () => {
  it("round-trips null, text, numbers, booleans, wide integers and blobs", () => {
    expect(decodeWireValue(encodeWireValue(null))).toBeNull();
    expect(decodeWireValue(encodeWireValue(undefined))).toBeNull();
    expect(decodeWireValue(encodeWireValue("hello"))).toBe("hello");
    expect(decodeWireValue(encodeWireValue(12.5))).toBe(12.5);
    expect(decodeWireValue(encodeWireValue(true))).toBe(1);
    expect(decodeWireValue(encodeWireValue(false))).toBe(0);
    expect(decodeWireValue(encodeWireValue(42n))).toBe(42);
    const wide = 9_007_199_254_740_993n;
    expect(decodeWireValue(encodeWireValue(wide))).toBe(wide);
    const blob = new Uint8Array([0, 1, 255, 16]);
    expect(decodeWireValue(encodeWireValue(blob))).toStrictEqual(blob);
    expect(decodeWireValue(encodeWireValue(new Uint8Array([1])))).toStrictEqual(
      new Uint8Array([1])
    );
    expect(
      decodeWireValue(encodeWireValue(new Uint8Array([1, 2])))
    ).toStrictEqual(new Uint8Array([1, 2]));
  });

  it("refuses a value SQLite would not bind", () => {
    expect(() => encodeWireValue({ not: "sqlite" })).toThrow(/unencodable/u);
  });

  it("refuses a malformed blob on the way back", () => {
    expect(() => decodeWireValue({ b64: "!!!!" })).toThrow(/malformed base64/u);
    expect(decodeWireValue(true)).toBe(1);
    expect(decodeWireValue(false)).toBe(0);
  });
});

describe("wire rows", () => {
  it("encode and decode a mixed image, keeping absent keys absent", () => {
    const encoded = encodeWireRow({
      title: "Ferry",
      bytes: new Uint8Array([9, 8, 7]),
      count: 99n,
      empty: null,
    });
    expect(encoded).toMatchObject({
      title: "Ferry",
      count: 99,
      empty: null,
    });
    expect("missing" in encoded).toBe(false);
    const decoded = decodeWireRow(encoded);
    expect(decoded.title).toBe("Ferry");
    expect(decoded.bytes).toStrictEqual(new Uint8Array([9, 8, 7]));
    expect(decoded.empty).toBeNull();
  });
});

describe(applyRowSql, () => {
  it("upserts assignable columns and no-ops a key-only row", () => {
    expect(applyRowSql("core_party", ["party_id", "name"], ["party_id"])).toBe(
      'INSERT INTO "core_party" ("party_id", "name")\n' +
        "VALUES (?, ?)\n" +
        'ON CONFLICT ("party_id") DO UPDATE SET "name" = excluded."name"'
    );
    expect(applyRowSql("core_party", ["party_id"], ["party_id"])).toContain(
      "DO NOTHING"
    );
    expect(applyRowSql('weird"table', ["a"], ["a"])).toContain(
      '"weird""table"'
    );
  });

  it("refuses an empty image or an empty key", () => {
    expect(() => applyRowSql("t", [], ["id"])).toThrow(/no columns/u);
    expect(() => applyRowSql("t", ["id"], [])).toThrow(
      /no declared primary key/u
    );
  });
});

describe(deleteRowSql, () => {
  it("deletes by every declared key column", () => {
    expect(deleteRowSql("core_tag", ["tag_id", "target_id"])).toBe(
      'DELETE FROM "core_tag" WHERE "tag_id" = ? AND "target_id" = ?'
    );
    expect(() => deleteRowSql("t", [])).toThrow(/no declared primary key/u);
  });
});
