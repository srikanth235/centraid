// Who may be invited (#1015, audit agenda/findings#2). The seeded vault put
// eight enrichment runners in the guest picker of a brand-new event, and
// tapping one wrote a real attendee row.

import { describe, expect, it } from "vitest";

import { guestOptions } from "./agenda-guests";

const SEED = [
  { party_id: "p_ocr", kind: "agent", display_name: "Photo OCR" },
  { party_id: "p_faces", kind: "agent", display_name: "Face recognition" },
  { party_id: "p_family", kind: "group", display_name: "Family" },
  { party_id: "p_acme", kind: "org", display_name: "Acme" },
  { party_id: "p_dog", kind: "animal", display_name: "Rufus" },
  {
    party_id: "p_maya",
    kind: "person",
    display_name: "Maya Alvarez",
    sort_name: "Alvarez, Maya",
  },
  {
    party_id: "p_jake",
    kind: "person",
    display_name: "Jake Bennett",
    sort_name: "Bennett, Jake",
  },
];

describe("guest options", () => {
  it("offers people and nothing else", () => {
    expect(guestOptions(SEED).map((option) => option.name)).toStrictEqual([
      "Maya Alvarez",
      "Jake Bennett",
    ]);
  });

  it("orders by the vault's sort name, not by display name", () => {
    const zed = {
      party_id: "p_zed",
      kind: "person",
      display_name: "Zed Adams",
      sort_name: "Adams, Zed",
    };
    expect(
      guestOptions([...SEED, zed]).map((option) => option.id)
    ).toStrictEqual(["p_zed", "p_maya", "p_jake"]);
  });

  it("drops a party with no id, and names an unnamed person", () => {
    expect(
      guestOptions([{ kind: "person", display_name: "Ghost" }])
    ).toStrictEqual([]);
    expect(guestOptions([{ party_id: "p_x", kind: "person" }])).toStrictEqual([
      { id: "p_x", name: "Person" },
    ]);
  });
});
