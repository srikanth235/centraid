import { deflateRawSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { MAX_ZIP_ENTRY_BYTES, readZipEntries, writeZipEntries } from "./zip.js";

function buildZip(): Buffer {
  const storedName = Buffer.from("hello.txt");
  const storedData = Buffer.from("hello world");
  const deflatedName = Buffer.from("nested/data.bin");
  const deflatedPlain = Buffer.from("compressed-bytes-here");
  const deflatedData = deflateRawSync(deflatedPlain);

  const local = (name: Buffer, data: Buffer, method: number): Buffer => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0, 12); // date
    header.writeUInt32LE(0, 14); // crc (unchecked)
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(method === 0 ? data.length : deflatedPlain.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra
    if (method === 8) {
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(deflatedPlain.length, 22);
    }
    return Buffer.concat([header, name, data]);
  };

  const local1 = local(storedName, storedData, 0);
  const local2 = local(deflatedName, deflatedData, 8);
  const locals = Buffer.concat([local1, local2]);

  const cdirEntry = (
    name: Buffer,
    data: Buffer,
    method: number,
    localOffset: number,
    uncompressed: number
  ): Buffer => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(uncompressed, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffset, 42);
    return Buffer.concat([header, name]);
  };

  const c1 = cdirEntry(storedName, storedData, 0, 0, storedData.length);
  const c2 = cdirEntry(
    deflatedName,
    deflatedData,
    8,
    local1.length,
    deflatedPlain.length
  );
  const cdir = Buffer.concat([c1, c2]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdir.length, 12);
  eocd.writeUInt32LE(locals.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([locals, cdir, eocd]);
}

describe("zip", () => {
  test("writeZipEntries round-trips deterministic UTF-8 paths and bytes", () => {
    const input = [
      { name: "notes/東京.md", data: Buffer.from("# 東京\n") },
      { name: "calendar.ics", data: Buffer.from("BEGIN:VCALENDAR\r\n") },
    ];
    const first = writeZipEntries(input);
    expect(writeZipEntries(input)).toStrictEqual(first);
    expect(
      readZipEntries(first).map((entry) => ({
        name: entry.name,
        text: entry.data.toString("utf8"),
      }))
    ).toStrictEqual([
      { name: "notes/東京.md", text: "# 東京\n" },
      { name: "calendar.ics", text: "BEGIN:VCALENDAR\r\n" },
    ]);
  });

  test("readZipEntries extracts stored and deflated files", () => {
    const entries = readZipEntries(buildZip());
    expect(entries.map((e) => e.name).sort()).toStrictEqual([
      "hello.txt",
      "nested/data.bin",
    ]);
    const hello = entries.find((e) => e.name === "hello.txt")!;
    expect(hello.data.toString("utf8")).toBe("hello world");
    const nested = entries.find((e) => e.name === "nested/data.bin")!;
    expect(nested.data.toString("utf8")).toBe("compressed-bytes-here");
  });

  test("readZipEntries throws on a non-zip buffer", () => {
    expect(() => readZipEntries(Buffer.from("not a zip"))).toThrow(
      /not a zip file/u
    );
  });

  test("rejects traversal names and truncated entry data", () => {
    const traversal = buildZip();
    const firstCentral = traversal.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02])
    );
    traversal.write("../x.txt", firstCentral + 46, "utf8");
    expect(() => readZipEntries(traversal)).toThrow(/unsafe zip entry name/u);

    const truncated = buildZip().subarray(0, buildZip().length - 30);
    expect(() => readZipEntries(truncated)).toThrow(/zip file|truncated zip/u);
  });

  test("rejects an archive-bomb declaration before inflating it", () => {
    const bomb = buildZip();
    const firstCentral = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, firstCentral + 24);
    expect(() => readZipEntries(bomb)).toThrow(/exceeds uncompressed limit/u);
  });
});
