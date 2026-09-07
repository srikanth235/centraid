// THE REVEAL LEG (#996, ruling W6-D2), and what survived the permit.
//
// The permit's own arithmetic is gone with the token — there is nothing left
// to mint, spend or refuse on this side. What these pin is the half that was
// never about the token: a revealed value carries its OWN clock, states how
// long it has been on screen, and takes itself off at about thirty seconds
// whether or not anyone looked. The reason for that number was never the
// permit's lifetime; it was the shoulder standing behind the member.
import { describe, expect, it } from "vitest";

import {
  REVEAL_LIFE_MS,
  concealsInSeconds,
  isRevealExpired,
  revealedForSeconds,
} from "./reveal.ts";
import type { RevealRequest, SidecarTarget } from "./reveal.ts";

const T0 = 1_700_000_000_000;

describe("a revealed value carries its own clock", () => {
  it("states how long it has been open and how long is left", () => {
    expect(revealedForSeconds(T0, T0)).toBe(0);
    expect(concealsInSeconds(T0, T0)).toBe(REVEAL_LIFE_MS / 1000);
    expect(revealedForSeconds(T0, T0 + 12_400)).toBe(12);
    expect(concealsInSeconds(T0, T0 + 12_400)).toBe(18);
  });

  it("floors both at zero rather than counting backwards", () => {
    // A negative countdown on screen is a clock that has stopped meaning
    // anything; the value is already gone by then either way.
    expect(concealsInSeconds(T0, T0 + REVEAL_LIFE_MS * 3)).toBe(0);
    expect(revealedForSeconds(T0, T0 - 5_000)).toBe(0);
  });

  it("conceals itself at its life, and stays concealed", () => {
    expect(isRevealExpired(T0, T0 + REVEAL_LIFE_MS - 1)).toBe(false);
    expect(isRevealExpired(T0, T0 + REVEAL_LIFE_MS)).toBe(true);
    expect(isRevealExpired(T0, T0 + REVEAL_LIFE_MS * 10)).toBe(true);
  });

  it("keeps the thirty seconds the gateway's gate used", () => {
    // The number moved seats; it did not change. It was
    // `LOCKER_ITEM_PERMIT_MS` on the gateway and governs the same thing here.
    expect(REVEAL_LIFE_MS).toBe(30_000);
  });
});

describe("a request names one field, and a sidecar names an address", () => {
  it("carries the field asked for and nothing else", () => {
    const request: RevealRequest = { itemId: "l1", field: "password" };
    expect(Object.keys(request).toSorted()).toStrictEqual(["field", "itemId"]);
  });

  it("addresses a sidecar row by id and column, never by value", () => {
    // The shell's door takes the ROW's own id, so what this app resolves out
    // of the detail it is holding is an address. A value here would be the
    // plaintext travelling before the receipt that records it.
    const sidecar: SidecarTarget = {
      entity: "locker.item_field",
      entityId: "f1",
      column: "value_sealed",
    };
    const request: RevealRequest = {
      itemId: "l1",
      field: "field:f1",
      sidecar,
      label: "Recovery code",
    };
    expect(request.sidecar).toStrictEqual(sidecar);
    expect(JSON.stringify(request)).not.toContain("value_sealed:");
    expect(Object.keys(sidecar).toSorted()).toStrictEqual([
      "column",
      "entity",
      "entityId",
    ]);
  });
});
