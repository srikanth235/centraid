import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
  personal?: boolean;
}
interface LinkRow {
  linkId: string;
  vaultId: string;
  partyId: string;
  approved: boolean;
  label?: string | null;
}
interface ShareDestination {
  id: string;
  label: string;
  partyId?: string;
  vaultId?: string;
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/share-kit.ts")
).href;
const shareKit = (await import(moduleUrl)) as {
  linkedDestinations: (
    links: readonly LinkRow[],
    scopes: readonly Scope[]
  ) => ShareDestination[];
  peopleDestinations: (
    people: readonly { partyId: string; label: string; vaultId?: string }[],
    scopes: readonly Scope[]
  ) => ShareDestination[];
  selectedShareMembers: (
    destinations: readonly ShareDestination[],
    selections: Readonly<Record<string, "read" | "read+write">>
  ) => Array<{
    partyId?: string;
    vaultId?: string;
    capability: "read" | "read+write";
  }>;
  selectionsForCircle: (
    destinations: readonly ShareDestination[],
    circle: {
      circleId: string;
      label: string;
      members: Array<{
        partyId?: string;
        capability: "read" | "read+write";
      }>;
    }
  ) => Record<string, "read" | "read+write">;
  readShareCircles: () => Promise<Array<{ circleId: string; label: string }>>;
  readShareDestinations: (
    scopes: readonly Scope[]
  ) => Promise<ShareDestination[]>;
  isPendingPartyId: (partyId: string) => boolean;
};

const OWN: Scope = {
  id: "own",
  label: "Library",
  canWrite: true,
  personal: true,
};
const FAMILY: Scope = {
  id: "fam",
  label: "Family",
  canWrite: true,
  personal: false,
};
describe("linkedDestinations — approved links not already mounted", () => {
  it("names the OTHER side of the link by the label the link carries (#750)", () => {
    const links: LinkRow[] = [
      {
        linkId: "l1",
        vaultId: "peer-1",
        partyId: "party-peer",
        approved: true,
        label: "Asha's photos",
      },
    ];
    expect(shareKit.linkedDestinations(links, [OWN])).toStrictEqual([
      {
        id: "peer-1",
        label: "Asha's photos",
        partyId: "party-peer",
        vaultId: "peer-1",
      },
    ]);
  });

  it("never dresses a vault id up as a name when no label is known", () => {
    const links: LinkRow[] = [
      {
        linkId: "l1",
        vaultId: "vlt_0123456789abcdef",
        partyId: "party-peer",
        approved: true,
        label: null,
      },
    ];
    const [listed] = shareKit.linkedDestinations(links, [OWN]);
    expect(listed?.label).toBe("Linked vault");
    expect(listed?.label).not.toContain("vlt_");
  });

  it("excludes a link whose vault is already mounted — never listed twice", () => {
    const links: LinkRow[] = [
      { linkId: "l1", vaultId: "fam", partyId: "party-family", approved: true },
    ];
    expect(shareKit.linkedDestinations(links, [OWN, FAMILY])).toStrictEqual([]);
  });

  it("excludes an unapproved or revoked link", () => {
    const links: LinkRow[] = [
      {
        linkId: "l1",
        vaultId: "peer-1",
        partyId: "party-peer",
        approved: false,
      },
    ];
    expect(shareKit.linkedDestinations(links, [OWN])).toStrictEqual([]);
  });
});

describe("peopleDestinations — joined and invited identities", () => {
  it("keeps a party with no vault as an honest invited destination", () => {
    expect(
      shareKit.peopleDestinations(
        [
          { partyId: "asha", label: "Asha" },
          { partyId: "ben", label: "Ben", vaultId: "peer-ben" },
        ],
        [OWN]
      )
    ).toStrictEqual([
      { id: "party:asha", label: "Asha", partyId: "asha" },
      {
        id: "peer-ben",
        label: "Ben",
        partyId: "ben",
        vaultId: "peer-ben",
      },
    ]);
  });

  it("deliberately reuses one named circle's exact per-person capabilities", () => {
    expect(
      shareKit.selectionsForCircle(
        [
          { id: "party:asha", label: "Asha", partyId: "asha" },
          { id: "ben-vault", label: "Ben", partyId: "ben" },
          { id: "unrelated", label: "Cara", partyId: "cara" },
        ],
        {
          circleId: "trip",
          label: "Goa trip",
          members: [
            { partyId: "asha", capability: "read" },
            { partyId: "ben", capability: "read+write" },
          ],
        }
      )
    ).toStrictEqual({
      "party:asha": "read",
      "ben-vault": "read+write",
    });
  });

  it("builds one multi-member array with an independent capability per person", () => {
    expect(
      shareKit.selectedShareMembers(
        [
          { id: "party:asha", label: "Asha", partyId: "asha" },
          {
            id: "ben-vault",
            label: "Ben",
            partyId: "ben",
            vaultId: "ben-vault",
          },
          { id: "cara-vault", label: "Cara", vaultId: "cara-vault" },
        ],
        {
          "party:asha": "read",
          "ben-vault": "read+write",
        }
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

  it("drops a selected person whose identity is still a pending overlay id", () => {
    expect(
      shareKit.selectedShareMembers(
        [
          {
            id: "party:pending:intent-1:0",
            label: "Cara",
            partyId: "pending:intent-1:0",
          },
          { id: "party:asha", label: "Asha", partyId: "asha" },
        ],
        {
          "party:pending:intent-1:0": "read",
          "party:asha": "read",
        }
      )
    ).toStrictEqual([{ partyId: "asha", capability: "read" }]);
  });
});

describe("isPendingPartyId", () => {
  it("names the offline overlay's placeholder id and nothing else", () => {
    expect(shareKit.isPendingPartyId("pending:intent-1:0")).toBe(true);
    expect(shareKit.isPendingPartyId("asha")).toBe(false);
  });
});

describe("readShareDestinations — live window.centraid.links()", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("loads linked people without listing another vault owned by me", async () => {
    (globalThis as { window?: unknown }).window = {
      centraid: {
        links: () =>
          Promise.resolve([
            {
              linkId: "l1",
              vaultId: "peer-1",
              partyId: "party-peer",
              approved: true,
            },
          ]),
      },
    };
    const listed = await shareKit.readShareDestinations([OWN, FAMILY]);
    expect(listed.map((d: ShareDestination) => d.id)).toStrictEqual(["peer-1"]);
  });

  it("answers no people when the host has no People or link plane", async () => {
    (globalThis as { window?: unknown }).window = { centraid: {} };
    const listed = await shareKit.readShareDestinations([OWN, FAMILY]);
    expect(listed).toStrictEqual([]);
  });

  it("prefers People targets so an invitation does not need a vault", async () => {
    (globalThis as { window?: unknown }).window = {
      centraid: {
        shareTargets: () =>
          Promise.resolve([{ partyId: "asha", label: "Asha" }]),
      },
    };
    await expect(
      shareKit.readShareDestinations([OWN, FAMILY])
    ).resolves.toStrictEqual([
      { id: "party:asha", label: "Asha", partyId: "asha" },
    ]);
  });

  it("loads deliberate named circles from the host without inventing one", async () => {
    (globalThis as { window?: unknown }).window = {
      centraid: {
        shareCircles: () =>
          Promise.resolve([
            { circleId: "trip", label: "Goa trip", members: [] },
          ]),
      },
    };
    await expect(shareKit.readShareCircles()).resolves.toMatchObject([
      { circleId: "trip", label: "Goa trip" },
    ]);
  });
});
