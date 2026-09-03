import { describe, expect, it } from "vitest";

import { base32Decode } from "@centraid/blueprints/apps/locker/totp";

import { otpauthSeed, seedFromEntry } from "./otpauth";

describe(otpauthSeed, () => {
  it("reads the secret out of a well-formed otpauth URI", () => {
    expect(
      otpauthSeed(
        "otpauth://totp/Example:me@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Example"
      )
    ).toBe("JBSWY3DPEHPK3PXP");
  });

  it("hands back a seed the shared decoder accepts", () => {
    const seed = otpauthSeed("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP") ?? "";
    expect(base32Decode(seed)).not.toBeNull();
  });

  it("refuses anything that is not an otpauth code rather than salvaging it", () => {
    expect(otpauthSeed("https://example.test")).toBeNull();
    expect(otpauthSeed("WIFI:S:home;T:WPA;P:hunter2;;")).toBeNull();
    expect(otpauthSeed("otpauth://hotp/A?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(otpauthSeed("otpauth://totp/A")).toBeNull();
    expect(otpauthSeed("otpauth://totp/A?issuer=Example")).toBeNull();
  });

  it("refuses a secret that is not base32", () => {
    expect(otpauthSeed("otpauth://totp/A?secret=not-base-32!")).toBeNull();
  });
});

describe(seedFromEntry, () => {
  it("takes a bare base32 seed as it is, spacing and case included", () => {
    expect(seedFromEntry(" jbswy3dp ehpk3pxp ")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("unwraps a pasted otpauth URI", () => {
    expect(seedFromEntry("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP")).toBe(
      "JBSWY3DPEHPK3PXP"
    );
  });

  it("answers null for an empty or unreadable entry", () => {
    expect(seedFromEntry("   ")).toBeNull();
    expect(seedFromEntry("hunter2!")).toBeNull();
  });
});
