/*
 * THE REPLAY WINDOW ON A SIGNED MEMBER INTENT (#1014, V7).
 *
 * A member's envelope used to be good forever: anything that captured one —
 * a relay, a backup of the member's outbox, a log — could present it again
 * months later and the origin would run it. The window and the nonce are
 * inside the SIGNED bytes, which is what makes them un-editable by whoever is
 * holding the copy, and they ride as a TRAILING pair so a peer built before
 * this signs and verifies exactly the bytes it always did.
 */
import { describe, expect, test } from "vitest";

import {
  memberIntentBytes,
  memberIntentExpired,
} from "./subscription-intent.js";
import type { MemberIntentEnvelope } from "./subscription-intent.js";

const base: MemberIntentEnvelope = {
  intentId: "intent-1",
  shapeId: "share:auth-1",
  originVaultId: "vlt_owner",
  memberVaultId: "vlt_member",
  appId: "photos",
  action: "update-asset",
  input: { asset_id: "a1", title: "Ours" },
  baseVersions: [{ entity: "media.asset", rowId: "a1", version: 4 }],
};

describe("the signed bytes", () => {
  test("an envelope that states no window signs the bytes it always did", () => {
    // The compatibility claim, spelled out: no trailing element at all.
    const canonical = memberIntentBytes(base).toString("utf8");
    expect(JSON.parse(canonical)).toHaveLength(9);
  });

  test("a stated window and nonce are covered by the signature", () => {
    const stamped = memberIntentBytes({
      ...base,
      expiresAt: "2026-09-11T00:00:00.000Z",
      nonce: "n-1",
    });
    expect(JSON.parse(stamped.toString("utf8"))).toHaveLength(10);
    // Stripping the pair yields the OLD form — different bytes, so the
    // signature the sender made does not verify against it.
    expect(stamped.equals(memberIntentBytes(base))).toBe(false);
  });

  test("changing only the nonce changes the bytes", () => {
    const first = memberIntentBytes({ ...base, nonce: "n-1" });
    const second = memberIntentBytes({ ...base, nonce: "n-2" });
    expect(first.equals(second)).toBe(false);
  });
});

describe("the window itself", () => {
  const now = new Date("2026-09-10T12:00:00.000Z");

  test("an envelope with no window never expires", () => {
    expect(memberIntentExpired(base, now)).toBe(false);
  });

  test("a window still open lets the envelope through", () => {
    expect(
      memberIntentExpired(
        { ...base, expiresAt: "2026-09-10T12:00:01.000Z" },
        now
      )
    ).toBe(false);
  });

  test("a window that has closed refuses it", () => {
    expect(
      memberIntentExpired(
        { ...base, expiresAt: "2026-09-10T11:59:59.000Z" },
        now
      )
    ).toBe(true);
  });

  test("an unparseable instant is not a licence to run forever", () => {
    expect(memberIntentExpired({ ...base, expiresAt: "soon" }, now)).toBe(true);
  });
});
