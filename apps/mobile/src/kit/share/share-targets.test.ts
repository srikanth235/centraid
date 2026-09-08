import { describe, expect, test } from "vitest";

import {
  nativeNamedShareCircles,
  nativeShareTargets,
  selectionsForNativeCircle,
  selectedNativeShareMembers,
} from "./share-targets";

/** An approved link to `partyId`'s own vault, which is what makes a person
 *  reachable at all. */
function linkTo(partyId: string, vaultId: string, label?: string) {
  return {
    vaultA: "owner-vault",
    vaultB: vaultId,
    partyIdA: "owner",
    partyIdB: partyId,
    ...(label ? { labelB: label } : {}),
    approved: true,
    revoked: false,
  };
}

describe(nativeShareTargets, () => {
  test("drops agent and animal parties — a recognition recipe is not an audience", () => {
    // Founding a vault creates six agent parties; before this filter they led
    // every share sheet in the product, above the actual people.
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [],
        links: [
          linkTo("ocr", "ocr-vault"),
          linkTo("dog", "dog-vault"),
          linkTo("asha", "asha-vault"),
          linkTo("ben", "ben-vault"),
        ],
        parties: [
          { party_id: "owner", kind: "person", display_name: "Priya" },
          { party_id: "ocr", kind: "agent", display_name: "Photo OCR" },
          { party_id: "dog", kind: "animal", display_name: "Rufus" },
          { party_id: "asha", kind: "person", display_name: "Asha" },
          // No kind at all: unstamped is not a refusal.
          { party_id: "ben", display_name: "Ben" },
        ],
      }).map((target) => target.label)
    ).toStrictEqual(["Asha", "Ben"]);
  });

  test("a refused party stays refused even when it carries a link", () => {
    // The linked-only pass exists for someone the directory has no row for.
    // It must not become a second door for a row the directory DID answer
    // about and ruled out — that would put the six recognition recipes back
    // in every sheet, this time nameless.
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [],
        links: [linkTo("owner", "owner-elsewhere"), linkTo("ocr", "ocr-vault")],
        parties: [
          { party_id: "owner", kind: "person", display_name: "Priya" },
          { party_id: "ocr", kind: "agent", display_name: "Photo OCR" },
        ],
      })
    ).toStrictEqual([]);
  });

  test("a person with no link is not a share target", () => {
    // A share is DELIVERED into the receiver's own vault. Someone the member
    // typed into People has no vault to deliver to, so listing them would
    // offer a reach the product cannot perform.
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [{ vaultId: "owner-vault", label: "My vault", canWrite: true }],
        parties: [
          { party_id: "owner", display_name: "Priya" },
          { party_id: "asha", display_name: "Asha" },
          { party_id: "ben", display_name: "Ben" },
        ],
        links: [linkTo("ben", "ben-vault")],
      })
    ).toStrictEqual([
      { id: "ben-vault", label: "Ben", partyId: "ben", vaultId: "ben-vault" },
    ]);
  });

  test("a vault this device has mounted is one of the member's own, not a person", () => {
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [
          { vaultId: "owner-vault", label: "My vault", canWrite: true },
          { vaultId: "studio-vault", label: "Studio", canWrite: true },
        ],
        parties: [{ party_id: "me-again", display_name: "Studio" }],
        links: [linkTo("me-again", "studio-vault")],
      })
    ).toStrictEqual([]);
  });

  test("a linked person with no directory entry keeps their own name (#750)", () => {
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        scopes: [],
        parties: [],
        links: [linkTo("asha", "asha-vault", "Asha")],
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
      links: [linkTo("unnamed", "vlt_0123456789abcdef")],
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

  test("never lists an offline-queued person — an overlay id names nobody", () => {
    // The outbox projects a party no vault has settled, so it can hold no
    // link either. It falls out of the list for the same reason anyone
    // unlinked does, rather than needing a rule of its own.
    expect(
      nativeShareTargets({
        sourceVaultId: "owner-vault",
        ownerPartyId: "owner",
        scopes: [],
        parties: [
          { party_id: "asha", display_name: "Asha" },
          { party_id: "pending:i1:party", display_name: "Nadia" },
        ],
        links: [linkTo("asha", "asha-vault")],
      }).map((target) => target.partyId)
    ).toStrictEqual(["asha"]);
  });

  test("submits multiple people with per-person capability", () => {
    expect(
      selectedNativeShareMembers(
        [
          {
            id: "asha-vault",
            partyId: "asha",
            vaultId: "asha-vault",
            label: "Asha",
          },
          {
            id: "ben-vault",
            partyId: "ben",
            vaultId: "ben-vault",
            label: "Ben",
          },
        ],
        { "asha-vault": "read", "ben-vault": "read+write" }
      )
    ).toStrictEqual([
      { partyId: "asha", vaultId: "asha-vault", capability: "read" },
      { partyId: "ben", vaultId: "ben-vault", capability: "read+write" },
    ]);
  });

  test("offers only Tally-backed named circles and selects their exact roster", () => {
    const targets = [
      {
        id: "asha-vault",
        partyId: "asha",
        label: "Asha",
        vaultId: "asha-vault",
      },
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
          { partyId: "asha", vaultId: "asha-vault", capability: "read" },
          {
            partyId: "ben",
            vaultId: "ben-vault",
            capability: "read+write",
          },
        ],
      },
    ]);
    expect(selectionsForNativeCircle(targets, named[0]!)).toStrictEqual({
      "asha-vault": "read",
      "ben-vault": "read+write",
    });
  });
});
