// A TYPE IS A SET OF FIELDS, AND A SEALED VALUE ROUND-TRIPS UNCHANGED.
//
// Two claims, and the second is the one with teeth: an edit that touches a
// title must not overwrite a password the member never revealed. The vault
// reads `«sealed»` as "leave it alone" (packages/vault commands/locker.ts
// `isPlaceholder`), so the form seeds exactly that — and this file pins the
// placeholder to the vault's own constant by value, because a drifted string
// here would silently write the literal into a secret column.

import { describe, expect, it } from "vitest";

import {
  SEALED,
  SEALED_KEYS,
  allowedKeys,
  carriesMatchPolicy,
  draftFrom,
  emptySeed,
  fieldsFor,
  isReady,
  retype,
  seedFromDetail,
} from "./draft.ts";
import type { LockerDetail, LockerItemType } from "./types.ts";
import { TYPE_ORDER } from "./view-copy.ts";

const LOGIN: LockerDetail = {
  item_id: "l1",
  type: "login",
  title: "GitHub",
  username: "ana@example.test",
  password: "«sealed»",
  url: "https://github.example",
  url_match_policy: "exact-host",
  otp_seed: "JBSWY3DPEHPK3PXP",
  notes: "Rotated after the notice.",
  tags: ["work", "code"],
};

describe("the type decides the fields", () => {
  it("gives all six types a field set of their own", () => {
    for (const type of TYPE_ORDER) {
      expect(fieldsFor(type).length).toBeGreaterThan(0);
    }
  });

  it("never asks a card for a username, or Wi-Fi for a card number", () => {
    expect(allowedKeys("card")).not.toContain("username");
    expect(allowedKeys("wifi")).not.toContain("card_number");
    expect(allowedKeys("login")).toContain("username");
  });

  it("seals exactly the five columns the single-item read unseals", () => {
    expect([...SEALED_KEYS].toSorted()).toStrictEqual([
      "card_number",
      "content",
      "cvv",
      "otp_seed",
      "password",
    ]);
  });

  it("carries a match policy on the one type a page is matched against", () => {
    expect(carriesMatchPolicy("login")).toBe(true);
    for (const type of TYPE_ORDER.filter((each) => each !== "login")) {
      expect(carriesMatchPolicy(type)).toBe(false);
    }
  });

  it("degrades an unknown type to the note's fields rather than to nothing", () => {
    const unknown = "ssh-key" as unknown as LockerItemType;
    expect(fieldsFor(unknown)).toStrictEqual(fieldsFor("note"));
  });
});

describe("an edit pre-fills metadata plainly and secrets as the placeholder", () => {
  const seed = seedFromDetail(LOGIN);

  it("carries the metadata the member can already see", () => {
    expect(seed.mode).toBe("edit");
    expect(seed.itemId).toBe("l1");
    expect(seed.title).toBe("GitHub");
    expect(seed.tags).toBe("work, code");
    expect(seed.urlMatchPolicy).toBe("exact-host");
    expect(seed.fields["username"]).toBe("ana@example.test");
    expect(seed.fields["url"]).toBe("https://github.example");
    expect(seed.fields["notes"]).toBe("Rotated after the notice.");
  });

  it("SEEDS EVERY SEALED FIELD AS THE PLACEHOLDER, never as a value", () => {
    expect(SEALED).toBe("«sealed»");
    expect(seed.fields["password"]).toBe(SEALED);
    expect(seed.fields["otp_seed"]).toBe(SEALED);
    // The write built from it sends the placeholder, which the vault reads as
    // "unchanged" — the round trip this whole seeding exists for.
    expect(draftFrom(seed).fields["password"]).toBe(SEALED);
  });

  it("holds no revealed plaintext, whatever is on screen beside it", () => {
    const revealed = seedFromDetail({ ...LOGIN, password: "k7Q-vn2-Rme" });
    expect(revealed.fields["password"]).toBe(SEALED);
  });

  it("leaves a secret the item does not have out entirely", () => {
    const bare = seedFromDetail({ ...LOGIN, otp_seed: null });
    expect(bare.fields["otp_seed"]).toBeUndefined();
  });
});

describe("switching type keeps what the two share and drops the rest", () => {
  it("carries the title and the memo, and drops a foreign field", () => {
    const seed = retype(seedFromDetail(LOGIN), "wifi");
    expect(seed.type).toBe("wifi");
    expect(seed.title).toBe("GitHub");
    expect(seed.fields["notes"]).toBe("Rotated after the notice.");
    expect(seed.fields["username"]).toBeUndefined();
    // A password is a field BOTH types own, so it survives the switch.
    expect(seed.fields["password"]).toBe(SEALED);
  });
});

describe("the write door's draft", () => {
  it("insists on a title, because the list is titles", () => {
    expect(isReady(emptySeed())).toBe(false);
    expect(isReady({ ...emptySeed(), title: "  " })).toBe(false);
    expect(isReady({ ...emptySeed(), title: "Netflix" })).toBe(true);
  });

  it("sends the match policy for a login and for nothing else", () => {
    expect(draftFrom(seedFromDetail(LOGIN)).urlMatchPolicy).toBe("exact-host");
    expect(draftFrom(emptySeed("card")).urlMatchPolicy).toBeUndefined();
  });

  it("never sends an alias, because this app's action layer drops one", () => {
    expect(draftFrom(seedFromDetail(LOGIN)).alias).toBe("");
  });

  it("names the keys the chosen type owns, so nothing else can travel", () => {
    expect(draftFrom(emptySeed("card")).allowedKeys).toStrictEqual(
      allowedKeys("card")
    );
  });
});
