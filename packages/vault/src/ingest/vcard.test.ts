// vCard parser unit tests (issue #545 B6).

import { describe, expect, test } from "vitest";

import { normalizeHandle, parseVcards } from "./vcard.js";

describe("vcard", () => {
  test("normalizeHandle lowercases emails and strips tel separators", () => {
    expect(normalizeHandle("email", "  Ravi@Example.COM ")).toBe(
      "ravi@example.com"
    );
    expect(normalizeHandle("tel", "+91 98765-43210")).toBe("+919876543210");
    expect(normalizeHandle("tel", "(555) 123.4567")).toBe("5551234567");
  });

  test("parseVcards extracts FN, N, BDAY, EMAIL, TEL with labels", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Ravi Kumar",
      "N:Kumar;Ravi;;;",
      "BDAY:1988-03-12",
      "EMAIL;TYPE=WORK:Ravi@Example.com",
      "TEL;TYPE=CELL:+91 98765-43210",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Meera Iyer",
      "EMAIL:meera@example.com",
      "END:VCARD",
    ].join("\r\n");
    const cards = parseVcards(vcf);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toStrictEqual({
      fn: "Ravi Kumar",
      sortName: "Kumar, Ravi",
      bday: "1988-03-12",
      identifiers: [
        { scheme: "email", value: "ravi@example.com", label: "work" },
        { scheme: "tel", value: "+919876543210", label: "cell" },
      ],
    });
    expect(cards[1]).toStrictEqual({
      fn: "Meera Iyer",
      sortName: null,
      bday: null,
      identifiers: [
        { scheme: "email", value: "meera@example.com", label: null },
      ],
    });
  });

  test("parseVcards unfolds lines and strips grouping prefixes", () => {
    const vcf = [
      "BEGIN:VCARD",
      "FN:Long",
      "  Name",
      "item1.EMAIL;TYPE=HOME:a@b.c",
      "END:VCARD",
    ].join("\r\n");
    const [card] = parseVcards(vcf);
    expect(card?.fn).toBe("Long Name");
    expect(card?.identifiers).toStrictEqual([
      { scheme: "email", value: "a@b.c", label: "home" },
    ]);
  });

  test("parseVcards drops cards without FN", () => {
    expect(
      parseVcards(["BEGIN:VCARD", "EMAIL:x@y.z", "END:VCARD"].join("\n"))
    ).toStrictEqual([]);
  });

  test("parseVcards rejects a truncated or nested card", () => {
    expect(() => parseVcards(["BEGIN:VCARD", "FN:Meera"].join("\n"))).toThrow(
      /truncated vCard/u
    );
    expect(() =>
      parseVcards(["BEGIN:VCARD", "BEGIN:VCARD"].join("\n"))
    ).toThrow(/nested records/u);
  });
});
