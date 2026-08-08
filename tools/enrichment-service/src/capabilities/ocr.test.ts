import { describe, expect, it } from "vitest";

import { buildRecognitionDictionary, parseDictFile } from "./ocr.js";

describe(parseDictFile, () => {
  it("splits one character per line", () => {
    expect(parseDictFile("a\nb\nc\n")).toStrictEqual(["a", "b", "c"]);
  });

  it("drops only the final trailing-newline segment, not a genuine blank entry", () => {
    expect(parseDictFile("a\n\nb\n")).toStrictEqual(["a", "", "b"]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseDictFile("a\nb")).toStrictEqual(["a", "b"]);
  });
});

describe(buildRecognitionDictionary, () => {
  it("prepends the CTC blank and appends a space class", () => {
    expect(buildRecognitionDictionary(["a", "b", "c"])).toStrictEqual([
      "",
      "a",
      "b",
      "c",
      " ",
    ]);
  });
});
