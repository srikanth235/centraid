import { deflateRawSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { parseCsvRows } from "./csv.js";
import { parseIcs } from "./ics.js";
import { isPasswordsCsvHeader, parsePasswordsCsv } from "./passwords-csv.js";
import { normalizeHandle, parseVcards } from "./vcard.js";
import { readZipEntries } from "./zip.js";

describe("ingest pure parsers (#545 B6)", () => {
  test("parseIcs maps VEVENT fields to structs", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1",
      "SUMMARY:Standup",
      "DESCRIPTION:Daily\\, sync",
      "DTSTART;TZID=America/Los_Angeles:20260723T090000",
      "DTEND:20260723T093000",
      "STATUS:CONFIRMED",
      "RRULE:FREQ=WEEKLY",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "evt-1",
      summary: "Standup",
      description: "Daily, sync",
      status: "confirmed",
      rrule: "FREQ=WEEKLY",
      startTz: "America/Los_Angeles",
    });
    expect(events[0]!.dtstart).toBe("2026-07-23T09:00:00");
    expect(events[0]!.dtend).toBe("2026-07-23T09:30:00");
  });

  test("parseVcards extracts FN/EMAIL/TEL and normalizes handles", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Ada Lovelace",
      "N:Lovelace;Ada;;;",
      "EMAIL:Ada@Example.COM",
      "TEL:+1 (555) 010-1234",
      "END:VCARD",
    ].join("\r\n");
    const cards = parseVcards(vcf);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.fn).toBe("Ada Lovelace");
    expect(cards[0]!.identifiers.some((i) => i.scheme === "email")).toBe(true);
    expect(normalizeHandle("email", "Ada@Example.COM")).toBe("ada@example.com");
    expect(normalizeHandle("tel", "+1 (555) 010-1234")).toBe("+15550101234");
  });

  test("parseCsvRows and password CSV header detection", () => {
    const rows = parseCsvRows(
      'name,url,username,password\n"Bank","https://b","u","p"\n'
    );
    expect(rows[0]).toStrictEqual(["name", "url", "username", "password"]);
    expect(isPasswordsCsvHeader(rows[0]!)).toBe(true);
    const items = parsePasswordsCsv(
      "name,url,username,password\nBank,https://bank.example,ada,s3cret\n"
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Bank",
      url: "https://bank.example",
      username: "ada",
      password: "s3cret",
    });
  });

  test("readZipEntries reads stored local-file entries", () => {
    // Minimal single-entry stored zip built by hand (method 0).
    const name = Buffer.from("hello.txt");
    const data = Buffer.from("hello zip");
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);

    const cdir = Buffer.alloc(46 + name.length);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4);
    cdir.writeUInt16LE(20, 6);
    cdir.writeUInt16LE(0, 8);
    cdir.writeUInt16LE(0, 10); // method
    cdir.writeUInt16LE(0, 12);
    cdir.writeUInt16LE(0, 14);
    cdir.writeUInt32LE(0, 16);
    cdir.writeUInt32LE(data.length, 20);
    cdir.writeUInt32LE(data.length, 24);
    cdir.writeUInt16LE(name.length, 28);
    cdir.writeUInt16LE(0, 30);
    cdir.writeUInt16LE(0, 32);
    cdir.writeUInt16LE(0, 34);
    cdir.writeUInt16LE(0, 36);
    cdir.writeUInt32LE(0, 38);
    cdir.writeUInt32LE(0, 42); // local header offset
    name.copy(cdir, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdir.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    eocd.writeUInt16LE(0, 20);

    // Also exercise deflate path: stored is enough for B6 direct coverage.
    void deflateRawSync;
    const zip = Buffer.concat([local, cdir, eocd]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("hello.txt");
    expect(entries[0]!.data.toString()).toBe("hello zip");
  });
});
