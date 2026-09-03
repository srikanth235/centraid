import { describe, expect, it } from "vitest";

import { shQuote } from "./harness.mjs";

function unquote(quoted) {
  if (!quoted.startsWith("'") || !quoted.endsWith("'"))
    throw new Error(`not a single-quoted word: ${quoted}`);
  return quoted.slice(1, -1).replaceAll(`'\\''`, "'");
}

describe("shQuote", () => {
  it.each([
    ["a bare word", "capture"],
    ["spaces, which would otherwise split into separate argv words", "a b c"],
    [
      "an apostrophe, which would otherwise open a quote that never closes",
      "Priya's list",
    ],
    [
      "the exact share payload shape",
      "Shared from another app 7 — Priya's list",
    ],
    ["double quotes", 'he said "no"'],
    ["a backslash, literal inside single quotes", "back\\slash"],
    ["command substitution that must NOT be evaluated", "$(rm -rf /)"],
    ["a backtick pair", "`whoami`"],
    ["a semicolon and an ampersand", "one; two && three"],
    ["a newline", "line one\nline two"],
    ["the empty string", ""],
    ["only quotes", "'''"],
  ])("round-trips %s", (_label, raw) => {
    expect(unquote(shQuote(raw))).toBe(raw);
  });

  it("produces exactly one shell word", () => {
    const quoted = shQuote("a b — Priya's list");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1).replaceAll(`'\\''`, "")).not.toContain("'");
  });
});
