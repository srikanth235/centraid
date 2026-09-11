// Spec for `shQuote` (#890 follow-up).
//
// Small, but it guards a hazard that is invisible at every layer above it. The
// host never sees a shell — `spawnText` passes argv directly — so a flow author
// reasonably assumes their data is safe. It is not: `adb shell` joins its
// arguments with spaces and hands the result to `/system/bin/sh` on the DEVICE
// without escaping, so the payload is parsed there. A share-intent flow shipped
// with an unquoted payload containing a space and an apostrophe, which would
// have failed on the device before asserting anything, and no test at any tier
// would have said why.
//
// The cases below are the shapes that actually break: word splitting, an
// unterminated quote, and the shell metacharacters that would otherwise be
// interpreted rather than delivered.

import { describe, expect, it } from "vitest";

import { shQuote } from "./harness.mjs";

/** What `sh` would produce for a single-quoted word: the literal characters. */
function unquote(quoted) {
  // Mirrors sh's own rule — inside single quotes every character is literal, and
  // `'\''` is the idiom for embedding one quote. Written as a decoder rather
  // than a fixed expected string so each case states the ROUND TRIP, which is
  // the property that matters, instead of restating the implementation.
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
    // The property the round trip alone does not state: whatever is inside, the
    // result must be ONE word to `sh`. A quoted string that closes early would
    // still round-trip through the decoder above while splitting on the device.
    const quoted = shQuote("a b — Priya's list");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Every interior quote is part of the `'\''` idiom — never a bare one, which
    // is what would terminate the word early.
    expect(quoted.slice(1, -1).replaceAll(`'\\''`, "")).not.toContain("'");
  });
});
