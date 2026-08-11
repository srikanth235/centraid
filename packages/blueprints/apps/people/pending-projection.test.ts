// People's pending-write projection (issue #738) — pure declaration checks,
// same convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts.
import { describe, expect, test } from "vitest";

import { peoplePendingProjection } from "./pending-projection.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("People's pending-write projection", () => {
  test("add-person mints a core.party row plus its 1:1 people.profile", () => {
    const mutations = peoplePendingProjection.actions["add-person"]!(
      { display_name: "Ada Lovelace", cadence_days: 30, role: "Friend" },
      ctx("intent-1")
    );
    expect(mutations).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "pending-intent-1",
        values: {
          party_id: "pending-intent-1",
          kind: "person",
          display_name: "Ada Lovelace",
        },
      },
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "pending-intent-1-profile",
        values: {
          profile_id: "pending-intent-1-profile",
          party_id: "pending-intent-1",
          cadence_days: 30,
          role: "Friend",
        },
      },
    ]);
  });

  test("add-person with no display_name projects nothing", () => {
    expect(
      peoplePendingProjection.actions["add-person"]!(
        { cadence_days: 30 },
        ctx("intent-2")
      )
    ).toStrictEqual([]);
  });

  test("edit-person always upserts core.party's display_name; people.profile only when profile_id rides along", () => {
    expect(
      peoplePendingProjection.actions["edit-person"]!(
        { party_id: "party-1", display_name: "Renamed" },
        ctx("intent-3")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "party-1",
        values: { display_name: "Renamed" },
      },
    ]);

    expect(
      peoplePendingProjection.actions["edit-person"]!(
        {
          party_id: "party-1",
          display_name: "Renamed",
          role: "Colleague",
          profile_id: "profile-1",
        },
        ctx("intent-4")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "party-1",
        values: { display_name: "Renamed" },
      },
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { role: "Colleague" },
      },
    ]);
  });

  test("trash-person/restore-person flip people_profile.deleted_at, keyed by profile_id", () => {
    expect(
      peoplePendingProjection.actions["trash-person"]!(
        { party_id: "party-1", profile_id: "profile-1" },
        ctx("intent-5")
      )
    ).toMatchObject([
      { op: "upsert", entity: "people.profile", rowId: "profile-1" },
    ]);
    expect(
      peoplePendingProjection.actions["restore-person"]!(
        { party_id: "party-1", profile_id: "profile-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { deleted_at: null },
      },
    ]);
  });

  test("trash-person/restore-person without a profile_id project nothing — there is no row to key the overlay on", () => {
    expect(
      peoplePendingProjection.actions["trash-person"]!(
        { party_id: "party-1" },
        ctx("intent-7")
      )
    ).toStrictEqual([]);
  });

  test("log-interaction stamps last_contacted_at on the profile row", () => {
    expect(
      peoplePendingProjection.actions["log-interaction"]!(
        { party_id: "party-1", kind: "Call", profile_id: "profile-1" },
        ctx("intent-8")
      )
    ).toMatchObject([
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { last_contacted_at: expect.any(String) },
      },
    ]);
  });

  test("star-person/unstar-person are deliberately undeclared", () => {
    expect(peoplePendingProjection.actions["star-person"]).toBeUndefined();
    expect(peoplePendingProjection.actions["unstar-person"]).toBeUndefined();
  });
});
