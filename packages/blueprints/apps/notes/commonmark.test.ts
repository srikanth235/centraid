import { describe, expect, it } from "vitest";

import { normalizeCommonMark, parseWikiLinks } from "./commonmark";

describe("portable CommonMark source", () => {
  it("preserves authored Unicode and returns stable wikilink anchors", () => {
    const body = "# Café\r\nSee [[Ravi 😀]] and [[東京]].\r\n";
    const normalized = normalizeCommonMark(body);
    expect(normalized).toBe("# Café\nSee [[Ravi 😀]] and [[東京]].\n");
    expect(parseWikiLinks(normalized)).toStrictEqual([
      {
        raw: "[[Ravi 😀]]",
        label: "Ravi 😀",
        start: 11,
        end: 22,
      },
      {
        raw: "[[東京]]",
        label: "東京",
        start: 27,
        end: 33,
      },
    ]);
  });

  it("leaves malformed, empty, and multiline brackets as text", () => {
    expect(parseWikiLinks("[[]] [[ ]] [[a\nb]] [[open")).toStrictEqual([]);
  });
});
