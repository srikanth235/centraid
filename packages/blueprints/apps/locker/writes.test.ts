// THE ONLINE-ONLY PARTITION (README-Locker §2, row "Writes").
//
// A secret write refuses to queue; a metadata write queues like any other.
// Asserted over the payload VALUES rather than over a mocked vault, because
// the rule is a property of the payload — which is exactly why the payloads
// are values in the first place.

import { describe, expect, it } from "vitest";

import lockerPendingProjection from "./pending-projection.ts";
import {
  ONLINE_ONLY_ACTIONS,
  addItemWrite,
  editItemWrite,
  needsGateway,
  purgeWrite,
  restoreWrite,
  starWrite,
  tagList,
  trashWrite,
} from "./writes.ts";

const DRAFT = {
  type: "login" as const,
  title: "  Email  ",
  tags: "personal, work,,  ",
  alias: "",
  urlMatchPolicy: "exact-host" as const,
  fields: {
    username: "me@example.test",
    password: "do-not-persist",
    cvv: "417",
  },
  allowedKeys: ["username", "password", "url"],
};

describe("a secret write refuses the offline queue", () => {
  it("marks add-item online only", () => {
    const write = addItemWrite(DRAFT);
    expect(write.onlineOnly).toBe(true);
    expect(needsGateway(write)).toBe(true);
    expect(write).toStrictEqual({
      action: "add-item",
      input: {
        type: "login",
        title: "Email",
        tags: ["personal", "work"],
        url_match_policy: "exact-host",
        username: "me@example.test",
        password: "do-not-persist",
      },
      onlineOnly: true,
    });
  });

  it("marks edit-item online only, and carries the item it edits", () => {
    const write = editItemWrite({ ...DRAFT, itemId: "item-1" });
    expect(write.onlineOnly).toBe(true);
    expect(write.input.item_id).toBe("item-1");
    expect(write.input.type).toBeUndefined();
  });

  it("drops a field the chosen type does not own, rather than sending it", () => {
    expect(addItemWrite(DRAFT).input.cvv).toBeUndefined();
  });

  it("leaves a blank alias untouched and sets a supplied one", () => {
    expect(addItemWrite(DRAFT).input.alias).toBeUndefined();
    expect(
      addItemWrite({ ...DRAFT, alias: "  locker:@github:password " }).input
        .alias
    ).toBe("locker:@github:password");
  });

  it("names every secret-bearing action, and only those", () => {
    // #872 adds a custom field and a passkey slot (sealed values in the
    // payload) and the plaintext export (every secret in the RESULT).
    expect([...ONLINE_ONLY_ACTIONS].toSorted()).toStrictEqual([
      "add-item",
      "edit-item",
      "export",
      "set-field",
      "set-passkey",
    ]);
  });
});

describe("a metadata write queues", () => {
  const metadata = [
    starWrite("item-1", false),
    starWrite("item-1", true),
    trashWrite("item-1"),
    restoreWrite("item-1"),
    purgeWrite("item-1"),
  ];

  it.each(metadata)("$action carries no online-only flag", (write) => {
    expect(write.onlineOnly).toBeUndefined();
    expect(needsGateway(write)).toBe(false);
    expect(write.input).toStrictEqual({ item_id: "item-1" });
  });

  it("toggles the one product-wide star rather than inventing a second", () => {
    expect(starWrite("item-1", false).action).toBe("star-item");
    expect(starWrite("item-1", true).action).toBe("unstar-item");
  });
});

describe("the payload rule and the replica projection agree", () => {
  it("excludes exactly the online-only actions from the pending overlay", () => {
    const actions = lockerPendingProjection.actions as Record<
      string,
      { excluded?: boolean }
    >;
    const excluded = Object.entries(actions)
      .filter(([, value]) => value.excluded === true)
      .map(([action]) => action)
      .toSorted();
    expect(excluded).toStrictEqual([...ONLINE_ONLY_ACTIONS].toSorted());
  });
});

describe("tags are the house vocabulary, trimmed", () => {
  it("drops empties and whitespace", () => {
    expect(tagList(" work , , code ,")).toStrictEqual(["work", "code"]);
    expect(tagList("")).toStrictEqual([]);
  });
});
