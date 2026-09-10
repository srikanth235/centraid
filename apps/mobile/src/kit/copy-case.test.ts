import { describe, expect, it } from "vitest";

import { titleCaseWords } from "./copy-case";

const NOUNS = new Set(["Notes", "Trash"]);

describe(titleCaseWords, () => {
  it("passes a sentence-case label", () => {
    expect(titleCaseWords("Move this note to trash", NOUNS)).toStrictEqual([]);
  });

  it("names every Title Case word after the first", () => {
    expect(titleCaseWords("Move To Trash Now", NOUNS)).toStrictEqual([
      "To",
      "Now",
    ]);
  });

  it("lets a proper noun keep its capital anywhere", () => {
    expect(titleCaseWords("Send this to Notes", NOUNS)).toStrictEqual([]);
  });

  it("reads a clause after an em dash as its own sentence", () => {
    expect(
      titleCaseWords("Read-only note — open the writable copy", NOUNS)
    ).toStrictEqual([]);
  });

  it("does not mistake an acronym for Title Case", () => {
    expect(titleCaseWords("Export as PDF", NOUNS)).toStrictEqual([]);
  });

  it("ignores the trailing punctuation on a proper noun", () => {
    expect(titleCaseWords("Nothing is in Trash.", NOUNS)).toStrictEqual([]);
  });
});
