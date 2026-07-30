import { describe, expect, test } from "vitest";

import { base32Decode, computeTotp, genPassword, strength } from "./totp.ts";

const RFC_SHA1_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Locker RFC-6238 TOTP", () => {
  test.each([
    [59, "287 082"],
    [1_111_111_109, "081 804"],
    [1_111_111_111, "050 471"],
    [1_234_567_890, "005 924"],
    [2_000_000_000, "279 037"],
    [20_000_000_000, "353 130"],
  ])("matches the RFC SHA-1 vector at %i seconds", async (seconds, code) => {
    await expect(
      computeTotp(RFC_SHA1_SECRET, Math.floor(seconds / 30))
    ).resolves.toBe(code);
  });

  test("base32 accepts case, spacing and padding but rejects malformed seeds", () => {
    expect(Buffer.from(base32Decode("mzxw 6===") ?? []).toString("utf8")).toBe(
      "foo"
    );
    expect(base32Decode("MZXW6!")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });

  test("adjacent skew windows produce their own codes", async () => {
    const before = await computeTotp(RFC_SHA1_SECRET, 41_152_262);
    const current = await computeTotp(RFC_SHA1_SECRET, 41_152_263);
    const after = await computeTotp(RFC_SHA1_SECRET, 41_152_264);
    expect(new Set([before, current, after]).size).toBe(3);
  });
});

describe("Locker password helpers", () => {
  test("strength agrees with the five-factor meter", () => {
    expect(strength("abc").label).toBe("Weak");
    expect(strength("LongEnoughPassword9!")).toMatchObject({
      ratio: 1,
      label: "Strong",
      tone: "ok",
    });
  });

  test("the generator honors length and disabled character classes", () => {
    const lettersOnly = genPassword({ len: 64, num: false, sym: false });
    expect(lettersOnly).toHaveLength(64);
    expect(lettersOnly).toMatch(/^[A-Za-z]+$/u);
    const full = genPassword({ len: 64, num: true, sym: true });
    expect(full).toHaveLength(64);
    expect(full).toMatch(/^[A-Za-z0-9!@#$%^&*_=+-]+$/u);
  });
});
