import { describe, expect, it } from "vitest";

import {
  decodePairingTicket,
  findReusableProfile,
  foldIrohPairResponse,
  isFoldError,
  isTicketExpired,
} from "./gateway-pairing-core.js";
import type { PairingTicketPayload } from "./gateway-pairing-core.js";

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const validPayload: PairingTicketPayload = {
  v: 1,
  kind: "centraid-gw-pair",
  gw: "endpoint-ticket-string",
  t: "ticket-id",
  s: "one-time-secret",
  vaultName: "Personal",
  exp: Date.now() + 60_000,
};

describe(decodePairingTicket, () => {
  it("decodes a well-formed token", () => {
    expect(decodePairingTicket(encode(validPayload))).toStrictEqual(
      validPayload
    );
  });

  it("tolerates surrounding whitespace (paste artifact)", () => {
    expect(decodePairingTicket(`  ${encode(validPayload)}\n`)).toStrictEqual(
      validPayload
    );
  });

  it("rejects non-base64url garbage", () => {
    expect(decodePairingTicket("not a valid token")).toBeUndefined();
  });

  it("rejects valid base64url that is not JSON", () => {
    expect(
      decodePairingTicket(Buffer.from("hello", "utf8").toString("base64url"))
    ).toBeUndefined();
  });

  it("rejects a wrong version", () => {
    expect(
      decodePairingTicket(encode({ ...validPayload, v: 2 }))
    ).toBeUndefined();
  });

  it("rejects a wrong kind (e.g. the phone-pairing QR shape)", () => {
    expect(
      decodePairingTicket(
        encode({ v: 1, kind: "centraid-pair", ticket: "x", code: "y" })
      )
    ).toBeUndefined();
  });

  it.each(["gw", "t", "s"] as const)(
    "rejects a missing/empty %s field",
    (field) => {
      expect(
        decodePairingTicket(encode({ ...validPayload, [field]: "" }))
      ).toBeUndefined();
      const rest: Record<string, unknown> = { ...validPayload };
      delete rest[field];
      expect(decodePairingTicket(encode(rest))).toBeUndefined();
    }
  );

  it("rejects a non-numeric exp", () => {
    expect(
      decodePairingTicket(encode({ ...validPayload, exp: "soon" }))
    ).toBeUndefined();
  });

  it("accepts an empty vaultName (still a string)", () => {
    expect(
      decodePairingTicket(encode({ ...validPayload, vaultName: "" }))
    ).toStrictEqual({
      ...validPayload,
      vaultName: "",
    });
  });
});

describe(isTicketExpired, () => {
  it("is false strictly before expiry", () => {
    expect(isTicketExpired({ exp: 1000 }, 999)).toBe(false);
  });

  it("is true at or after expiry (server burns on ANY redemption attempt)", () => {
    expect(isTicketExpired({ exp: 1000 }, 1000)).toBe(true);
    expect(isTicketExpired({ exp: 1000 }, 1001)).toBe(true);
  });

  it("defaults `now` to the current clock", () => {
    expect(isTicketExpired({ exp: Date.now() + 60_000 })).toBe(false);
    expect(isTicketExpired({ exp: Date.now() - 1 })).toBe(true);
  });
});

describe(foldIrohPairResponse, () => {
  it("folds a successful response", () => {
    const folded = foldIrohPairResponse({
      ok: true,
      gatewayId: "gateway-endpoint",
      vaultId: "v1",
      vaultName: "Personal",
      vaultIds: ["v1", "v2"],
      vaults: [
        {
          enrollmentId: "enrollment-v1",
          role: "write",
          vaultId: "v1",
          vaultName: "Personal",
        },
        {
          enrollmentId: "enrollment-v2",
          role: "read",
          vaultId: "v2",
          vaultName: "Family",
        },
      ],
      gatewayName: "Home",
    });
    expect(isFoldError(folded)).toBe(false);
    expect(folded).toStrictEqual({
      gatewayId: "gateway-endpoint",
      vaultId: "v1",
      vaultIds: ["v1", "v2"],
      vaultName: "Personal",
      vaults: [
        {
          enrollmentId: "enrollment-v1",
          role: "write",
          vaultId: "v1",
          vaultName: "Personal",
        },
        {
          enrollmentId: "enrollment-v2",
          role: "read",
          vaultId: "v2",
          vaultName: "Family",
        },
      ],
      gatewayName: "Home",
    });
  });

  it("defaults vaultName to empty string when the gateway omits it", () => {
    const folded = foldIrohPairResponse({
      ok: true,
      gatewayId: "gateway-endpoint",
      vaultId: "v1",
    });
    expect(folded).toStrictEqual({
      gatewayId: "gateway-endpoint",
      vaultId: "v1",
      vaultIds: ["v1"],
      vaultName: "",
      vaults: [],
    });
  });

  it("maps ok:false + error:ticket_expired to the stable expired code", () => {
    const folded = foldIrohPairResponse({ ok: false, error: "ticket_expired" });
    expect(isFoldError(folded)).toBe(true);
    expect(folded).toStrictEqual({
      error: "ticket_expired",
      message: "This pairing code has expired.",
    });
  });

  it("maps any other rejection to invalid_ticket", () => {
    const folded = foldIrohPairResponse({ ok: false, error: "bad_secret" });
    expect(folded).toStrictEqual({
      error: "invalid_ticket",
      message: "bad_secret",
    });
  });

  it("treats ok:true with no vaultId as a malformed response", () => {
    const folded = foldIrohPairResponse({
      ok: true,
      gatewayId: "gateway-endpoint",
    });
    expect(folded).toStrictEqual({
      error: "bad_response",
      message: "Gateway did not return a vault id.",
    });
  });

  it("treats ok:true with no gateway EndpointId as malformed", () => {
    expect(foldIrohPairResponse({ ok: true, vaultId: "v1" })).toStrictEqual({
      error: "bad_response",
      message: "Gateway did not return its EndpointId.",
    });
  });
});

describe(findReusableProfile, () => {
  const profiles = [
    { id: "endpoint-a", endpointId: "endpoint-a" },
    { id: "endpoint-b", endpointId: "endpoint-b" },
    { id: "local" },
  ];

  it("finds an existing connection by stable EndpointId", () => {
    expect(findReusableProfile(profiles, "endpoint-a")?.id).toBe("endpoint-a");
  });

  it("does not identify a gateway by address-like cache data", () => {
    expect(
      findReusableProfile(profiles, "https://relay.example")
    ).toBeUndefined();
  });
});
