import { describe, expect, it } from "vitest";

import { normalizePairedVaults } from "./phone-link-core";
import { parsePairingInput, parsePairQr } from "./phone-link-parse";

function encodeGwPair(payload: {
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
}): string {
  const json = JSON.stringify({ v: 1, kind: "centraid-gw-pair", ...payload });
  // Node Buffer is available under vitest; mirrors gateway encodePairingTicket.
  return Buffer.from(json, "utf8").toString("base64url");
}

describe(parsePairingInput, () => {
  it("parses desktop centraid-pair JSON", () => {
    const raw = JSON.stringify({
      v: 1,
      kind: "centraid-pair",
      ticket: "ep-ticket",
      code: "ABCD",
    });
    expect(parsePairingInput(raw)).toStrictEqual({
      kind: "centraid-pair",
      ticket: "ep-ticket",
      code: "ABCD",
    });
    expect(parsePairQr(raw)).toStrictEqual({
      ticket: "ep-ticket",
      code: "ABCD",
    });
  });

  it("parses headless centraid-gw-pair one-line tickets", () => {
    const exp = Date.now() + 60_000;
    const token = encodeGwPair({
      gw: "gw-endpoint-ticket",
      t: "ticket-id",
      s: "one-time-secret",
      vaultName: "Family",
      exp,
    });
    expect(parsePairingInput(token)).toStrictEqual({
      kind: "centraid-gw-pair",
      gw: "gw-endpoint-ticket",
      t: "ticket-id",
      s: "one-time-secret",
      vaultName: "Family",
      exp,
    });
    expect(parsePairQr(token)).toBeUndefined();
  });

  it("rejects garbage and wrong kinds", () => {
    expect(parsePairingInput("")).toBeUndefined();
    expect(parsePairingInput("not-a-ticket")).toBeUndefined();
    expect(
      parsePairingInput(JSON.stringify({ v: 1, kind: "other" }))
    ).toBeUndefined();
    const bad = Buffer.from(
      JSON.stringify({ v: 1, kind: "centraid-gw-pair" }),
      "utf8"
    ).toString("base64url");
    expect(parsePairingInput(bad)).toBeUndefined();
  });

  it("rejects unknown gateway ticket kinds — the pair ticket is the only ticket (#603)", () => {
    // The founding-ticket kind lands in this bucket too: the parser
    // special-cases no kind, so any non-pair kind is refused the same way.
    const token = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "centraid-gw-legacy",
        gw: "refreshable-endpoint-hint",
        t: "one-time-id",
        s: "one-time-secret",
        exp: Date.now() + 60_000,
      }),
      "utf8"
    ).toString("base64url");
    expect(parsePairingInput(token)).toBeUndefined();
    expect(parsePairQr(token)).toBeUndefined();
  });

  it("tolerates surrounding whitespace", () => {
    const raw = `  ${JSON.stringify({
      v: 1,
      kind: "centraid-pair",
      ticket: "t",
      code: "c",
    })}  \n`;
    expect(parsePairingInput(raw)?.kind).toBe("centraid-pair");
  });
});

describe(normalizePairedVaults, () => {
  it("keeps the primary vault first and preserves every vault grant", () => {
    expect(
      normalizePairedVaults({
        vaultId: "personal",
        vaultIds: ["family", "personal"],
        vaults: [
          {
            enrollmentId: "family-enrollment",
            role: "read",
            vaultId: "family",
            vaultName: "Family",
          },
          {
            enrollmentId: "personal-enrollment",
            role: "write",
            vaultId: "personal",
            vaultName: "Personal",
          },
        ],
      })
    ).toStrictEqual([
      {
        enrollmentId: "personal-enrollment",
        role: "write",
        vaultId: "personal",
        vaultName: "Personal",
      },
      {
        enrollmentId: "family-enrollment",
        role: "read",
        vaultId: "family",
        vaultName: "Family",
      },
    ]);
  });

  it("accepts legacy primary-only responses", () => {
    expect(normalizePairedVaults({ vaultId: "personal" })).toStrictEqual([
      { vaultId: "personal" },
    ]);
  });
});
