// THE PASSPHRASE FLOOR (#1014, X13).
//
// The asymmetry is the whole point and is the part worth a test: the floor
// applies when a document is SEALED and never when one is OPENED, because a
// strength rule that can lock an owner out of their own recovery material is
// worse than the weak password it prevents.

import { describe, expect, test } from "vitest";

import {
  assertPassphraseFloor,
  unwrapPasswordDocument,
  wrapPasswordDocument,
} from "./password-wrap.js";

const AAD = Buffer.from("kit-aad");

function seal(passphrase: string) {
  return wrapPasswordDocument({
    label: "kit",
    kind: "centraid-test-kit",
    aad: AAD,
    createdAt: new Date(0).toISOString(),
    fingerprint: "fp",
    plain: { secret: "material" },
    passphrase,
  });
}

describe("passphrase floor", () => {
  test("twelve characters is enough, and so are four short words", () => {
    expect(() => assertPassphraseFloor("kit", "abcdefghijkl")).not.toThrow();
    expect(() => assertPassphraseFloor("kit", "one two by me")).not.toThrow();
  });

  test("a short single word is refused, with the rule in the message", () => {
    expect(() => assertPassphraseFloor("kit", "a")).toThrow(
      /at least 12 characters or 4 words/u
    );
    expect(() => assertPassphraseFloor("kit", "hunter2")).toThrow(
      /at least 12 characters or 4 words/u
    );
    // Whitespace is not entropy: padding to length with spaces still counts
    // one word, and the character count is the raw string, so this passes on
    // length alone — which is why the message names both shapes rather than
    // pretending the check is a strength estimate.
    expect(() => assertPassphraseFloor("kit", "")).toThrow(
      /password is required/u
    );
  });

  test("sealing refuses a weak passphrase", () => {
    expect(() => seal("hunter2")).toThrow(/at least 12 characters or 4 words/u);
  });

  test("opening a weak-passphrase document written before the floor still works", () => {
    // The only way to build one is to bypass the wrap's own check, which is
    // exactly the situation on disk: a kit sealed by an older build.
    const forged = seal("correct horse battery staple");
    const open = (passphrase: string) =>
      unwrapPasswordDocument<{ secret: string }>({
        label: "kit",
        kind: "centraid-test-kit",
        aad: AAD,
        value: forged,
        passphrase,
        parse: (plain) => plain as { secret: string },
        fingerprintOf: () => "fp",
      });
    expect(open("correct horse battery staple")).toStrictEqual({
      secret: "material",
    });
    // And `unwrap` carries no floor of its own: the empty string is still the
    // only shape it refuses outright.
    expect(() => open("")).toThrow(/password is required/u);
    expect(() => open("short")).toThrow(/wrong password or corrupt/u);
  });
});
