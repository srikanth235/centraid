import { describe, expect, it } from "vitest";

import {
  PERMIT_LIFE_MS,
  backoffText,
  concealsInSeconds,
  isPermitLive,
  isRevealExpired,
  permitCovers,
  permitFromAuth,
  permitRemainingSeconds,
  revealedForSeconds,
  spend,
} from "./permits.ts";

const T0 = 1_700_000_000_000;
const ASK = { itemId: "l1", field: "password" };

function minted(payload = {}) {
  const outcome = permitFromAuth(
    ASK,
    { ok: true, itemToken: "tok", ...payload },
    T0
  );
  if (outcome.kind !== "minted") throw new Error(outcome.kind);
  return outcome.permit;
}

describe("a permit is minted for one field of one item", () => {
  it("carries the field it was asked for", () => {
    const permit = minted();
    expect(permit).toStrictEqual({
      itemId: "l1",
      field: "password",
      token: "tok",
      expiresAt: T0 + PERMIT_LIFE_MS,
    });
  });

  it("honours the host's own expiry when it sends one", () => {
    const permit = minted({ expiresAt: new Date(T0 + 12_000).toISOString() });
    expect(permit.expiresAt).toBe(T0 + 12_000);
  });

  it("falls back to its nominal life when the expiry does not parse", () => {
    expect(minted({ expiresAt: "soon" }).expiresAt).toBe(T0 + PERMIT_LIFE_MS);
  });

  it("does not cover a second field, or a second item", () => {
    const permit = minted();
    expect(permitCovers(permit, ASK, T0)).toBe(true);
    expect(permitCovers(permit, { itemId: "l1", field: "cvv" }, T0)).toBe(
      false
    );
    expect(permitCovers(permit, { itemId: "l2", field: "password" }, T0)).toBe(
      false
    );
  });

  it("is one shot — spending it leaves nothing to hold", () => {
    expect(spend()).toBeNull();
  });
});

describe("a permit expires whether or not it was used", () => {
  const permit = minted();

  it("counts down in whole seconds and floors at zero", () => {
    expect(permitRemainingSeconds(permit, T0)).toBe(30);
    expect(permitRemainingSeconds(permit, T0 + 29_100)).toBe(1);
    expect(permitRemainingSeconds(permit, T0 + PERMIT_LIFE_MS)).toBe(0);
    expect(permitRemainingSeconds(permit, T0 + PERMIT_LIFE_MS + 5_000)).toBe(0);
    expect(permitRemainingSeconds(null, T0)).toBe(0);
  });

  it("stops covering the field it was minted for once it runs out", () => {
    expect(isPermitLive(permit, T0 + PERMIT_LIFE_MS - 1)).toBe(true);
    expect(isPermitLive(permit, T0 + PERMIT_LIFE_MS)).toBe(false);
    expect(permitCovers(permit, ASK, T0 + PERMIT_LIFE_MS)).toBe(false);
  });
});

describe("a refusal says which refusal it was", () => {
  it("relocks on an expired session rather than re-asking", () => {
    expect(
      permitFromAuth(ASK, { ok: false, code: "SESSION_EXPIRED" }, T0)
    ).toStrictEqual({ kind: "relock" });
  });

  it("shows the backoff a rate limit asks for", () => {
    expect(
      permitFromAuth(
        ASK,
        { ok: false, code: "RATE_LIMITED", retryAfterMs: 30_000 },
        T0
      )
    ).toStrictEqual({ kind: "refused", message: "Try again in 30 seconds." });
  });

  it("rounds a part-second backoff up, never down to nothing", () => {
    expect(backoffText(1)).toBe("Try again in 1 seconds.");
    expect(backoffText(2_400)).toBe("Try again in 3 seconds.");
  });

  it("passes a plain refusal through in the host's words", () => {
    expect(
      permitFromAuth(ASK, { ok: false, message: "That is not it." }, T0)
    ).toStrictEqual({ kind: "refused", message: "That is not it." });
  });

  it("treats a missing item token as a refusal, never a silent success", () => {
    expect(permitFromAuth(ASK, { ok: true }, T0).kind).toBe("refused");
  });
});

describe("the revealed field carries its own clock", () => {
  it("states how long it has been open and how long is left", () => {
    expect(revealedForSeconds(T0, T0 + 4_000)).toBe(4);
    expect(concealsInSeconds(T0, T0 + 4_000)).toBe(26);
  });

  it("conceals itself at the permit's life, and stays concealed", () => {
    expect(isRevealExpired(T0, T0 + PERMIT_LIFE_MS - 1)).toBe(false);
    expect(isRevealExpired(T0, T0 + PERMIT_LIFE_MS)).toBe(true);
    expect(concealsInSeconds(T0, T0 + PERMIT_LIFE_MS + 9_000)).toBe(0);
  });
});
