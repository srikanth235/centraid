import { describe, expect, test } from "vitest";

import {
  nativeNamedShareCircles,
  nativeShareTargets,
  selectionsForNativeCircle,
  selectedNativeShareMembers,
} from "./share-targets";

describe(nativeShareTargets, () => {
  test("keeps unjoined people invited and joins linked people to their vault", () => {
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [
          { vaultId: "owner-vault", label: "My vault", canWrite: true },
          {
            vaultId: "owner-other-vault",
            label: "My other vault",
            canWrite: true,
          },
        ],
        parties: [
          { party_id: "owner", display_name: "Priya" },
          { party_id: "asha", display_name: "Asha" },
          { party_id: "ben", display_name: "Ben" },
        ],
        links: [
          {
            vaultA: "owner-vault",
            vaultB: "ben-vault",
            partyIdA: "owner",
            partyIdB: "ben",
            approved: true,
            revoked: false,
          },
        ],
      })
    ).toStrictEqual([
      { id: "party:asha", label: "Asha", partyId: "asha" },
      {
        id: "ben-vault",
        label: "Ben",
        partyId: "ben",
        vaultId: "ben-vault",
      },
    ]);
  });

  test("a linked person with no directory entry keeps their own name, and a link with no person carries the vault's label (#750)", () => {
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        scopes: [],
        parties: [],
        links: [
          {
            vaultA: "owner-vault",
            vaultB: "asha-vault",
            partyIdA: "owner",
            partyIdB: "asha",
            labelA: "My vault",
            labelB: "Asha",
            approved: true,
            revoked: false,
          },
        ],
      })
    ).toStrictEqual([
      {
        id: "asha-vault",
        partyId: "asha",
        vaultId: "asha-vault",
        label: "Asha",
      },
    ]);
  });

  test("never dresses a vault id up as a name when the directory holds none", () => {
    const [target] = nativeShareTargets({
      sourceVaultId: "owner-vault",
      scopes: [],
      parties: [],
      links: [
        {
          vaultA: "owner-vault",
          vaultB: "vlt_0123456789abcdef",
          partyIdA: "owner",
          partyIdB: "unnamed",
          approved: true,
          revoked: false,
        },
      ],
    });
    expect(target?.label).toBe("Linked person");
    expect(target?.label).not.toContain("vlt_");
  });

  test("never treats an unrelated link as the destination", () => {
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        scopes: [],
        parties: [],
        links: [
          {
            vaultA: "a",
            vaultB: "b",
            partyIdA: "pa",
            partyIdB: "pb",
            approved: true,
            revoked: false,
          },
        ],
      })
    ).toStrictEqual([]);
  });

  test("submits multiple people with per-person capability and no fake invite vault", () => {
    expect(
      selectedNativeShareMembers(
        [
          { id: "party:asha", partyId: "asha", label: "Asha" },
          {
            id: "ben-vault",
            partyId: "ben",
            vaultId: "ben-vault",
            label: "Ben",
          },
        ],
        { "party:asha": "read", "ben-vault": "read+write" }
      )
    ).toStrictEqual([
      { partyId: "asha", capability: "read" },
      {
        partyId: "ben",
        vaultId: "ben-vault",
        capability: "read+write",
      },
    ]);
  });

  test("offers only Tally-backed named circles and selects their exact roster", () => {
    const targets = [
      { id: "party:asha", partyId: "asha", label: "Asha" },
      { id: "ben-vault", partyId: "ben", label: "Ben", vaultId: "ben-vault" },
    ];
    const named = nativeNamedShareCircles({
      ownerPartyId: "owner",
      targets,
      circles: [
        { circle_id: "trip", name: "Goa trip", owner_party_id: "owner" },
        {
          circle_id: "implicit",
          name: "Shared photo",
          owner_party_id: "owner",
        },
        {
          circle_id: "foreign",
          name: "Asha's group",
          owner_party_id: "asha",
        },
        {
          circle_id: "incomplete",
          name: "Old group",
          owner_party_id: "owner",
        },
      ],
      groups: [
        { group_id: "g1", circle_id: "trip" },
        { group_id: "g2", circle_id: "foreign" },
        { group_id: "g3", circle_id: "incomplete" },
      ],
      members: [
        {
          circle_id: "trip",
          party_id: "owner",
          capability: "read+write",
        },
        {
          circle_id: "incomplete",
          party_id: "missing-directory-party",
          capability: "read",
        },
        { circle_id: "trip", party_id: "asha", capability: "read" },
        {
          circle_id: "trip",
          party_id: "ben",
          capability: "read+write",
        },
      ],
    });
    expect(named).toStrictEqual([
      {
        circleId: "trip",
        label: "Goa trip",
        members: [
          { partyId: "asha", capability: "read" },
          {
            partyId: "ben",
            vaultId: "ben-vault",
            capability: "read+write",
          },
        ],
      },
    ]);
    expect(selectionsForNativeCircle(targets, named[0]!)).toStrictEqual({
      "party:asha": "read",
      "ben-vault": "read+write",
    });
  });
});
