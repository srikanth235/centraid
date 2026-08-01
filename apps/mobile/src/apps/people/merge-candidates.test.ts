import { describe, expect, test } from "vitest";

import { mergeCandidates } from "./merge-candidates";

interface Person {
  party_id: string;
  name: string;
}

const DIRECTORY: Person[] = [
  { party_id: "p1", name: "Ada Lovelace" },
  { party_id: "p2", name: "ada lovelace" },
  { party_id: "p3", name: "Grace Hopper" },
  { party_id: "p4", name: "Unnamed person" },
];

function directory(): Person[] {
  return DIRECTORY;
}

describe(mergeCandidates, () => {
  test("never offers to merge someone into themselves", () => {
    expect(
      mergeCandidates(directory(), "p1", "").map((person) => person.party_id)
    ).toStrictEqual(["p2", "p3", "p4"]);
  });

  test("an empty query offers the whole directory", () => {
    expect(mergeCandidates(directory(), undefined, "   ")).toHaveLength(4);
  });

  test("narrows on name, ignoring case and surrounding space", () => {
    expect(
      mergeCandidates(directory(), "p1", "  LOVE  ").map(
        (person) => person.party_id
      )
    ).toStrictEqual(["p2"]);
  });

  test("a query nobody matches offers nobody", () => {
    expect(mergeCandidates(directory(), "p1", "zzz")).toStrictEqual([]);
  });
});
