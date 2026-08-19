import { describe, expect, test } from "vitest";

import { grantAudiencesFrom } from "./grant-audiences.ts";

describe("docs grant audiences", () => {
  test("names people by party, then named circles with their size", () => {
    expect(
      grantAudiencesFrom(
        [
          { label: "Ravi", partyId: "party-ravi" },
          { label: "Asha", partyId: "party-asha" },
        ],
        [{ circleId: "circle-1", label: "Ski trip", members: [{}, {}, {}] }]
      )
    ).toStrictEqual([
      { kind: "party", id: "party-ravi", label: "Ravi" },
      { kind: "party", id: "party-asha", label: "Asha" },
      { kind: "circle", id: "circle-1", label: "Ski trip", memberCount: 3 },
    ]);
  });

  test("a destination with no party names a vault, not a person, and is dropped", () => {
    // A grant is addressed to a PARTY; a row the roster could not settle to
    // one has nobody for the grant plane to name.
    expect(grantAudiencesFrom([{ label: "Linked vault" }], [])).toStrictEqual(
      []
    );
  });

  test("a person queued offline is never offered", () => {
    // `pending:` is an overlay id no vault has settled — offering it would
    // record a grant against an identity that does not exist yet.
    expect(
      grantAudiencesFrom(
        [{ label: "Offline friend", partyId: "pending:intent-1:0" }],
        []
      )
    ).toStrictEqual([]);
  });

  test("an empty roster is a real answer, not a failure", () => {
    expect(grantAudiencesFrom([], [])).toStrictEqual([]);
  });
});
