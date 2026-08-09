// The unified give/lend destination model (issue #726 P6,
// apps/_shared/share-kit.ts). Replaces photos-copy-destinations.test.ts,
// which covered the retired P0 sole-destination shortcut
// (apps/photos/sharing.ts, deleted). ONE destination list now holds both the
// member's own other writable vaults and every linked person — never sorted
// or labelled by where a destination physically lives (D3).
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
  personal?: boolean;
  borrowed?: { edgeId: string; holderLabel: string };
}
interface LinkRow {
  linkId: string;
  vaultId: string;
  approved: boolean;
}
interface ShareDestination {
  id: string;
  label: string;
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/share-kit.ts")
).href;
const shareKit = (await import(moduleUrl)) as {
  ownVaultDestinations: (
    scopes: readonly Scope[],
    currentScopeId: string | null | undefined
  ) => ShareDestination[];
  linkedDestinations: (
    links: readonly LinkRow[],
    scopes: readonly Scope[]
  ) => ShareDestination[];
  shareDestinations: (
    scopes: readonly Scope[],
    currentScopeId: string | null | undefined,
    links: readonly LinkRow[]
  ) => ShareDestination[];
  loadShareDestinations: (
    currentScopeId: string | null | undefined,
    scopes: readonly Scope[]
  ) => Promise<ShareDestination[]>;
  shareBlockedReason: (
    destinations: readonly ShareDestination[]
  ) => string | null;
  wholeLibraryLendScope: (
    mintedIdFamilies: readonly string[]
  ) => Array<{ schema: string; table: string }>;
  searchReachWarning: (
    reach: readonly LendSearchReach[] | undefined,
    destinationLabel: string
  ) => string | null;
  GIVE_IRREVOCABLE_WARNING: string;
  STOP_LENDING_LABEL: string;
};

interface LendSearchReach {
  schema: string;
  table: string;
  masksSearchableColumns: boolean;
}

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
const READ_ONLY: Scope = {
  id: "tom",
  label: "Tom's photographs",
  canWrite: false,
  personal: false,
};
const BORROWED: Scope = {
  id: "lent",
  label: "Priya",
  canWrite: false,
  personal: false,
  borrowed: { edgeId: "edge-1", holderLabel: "Priya" },
};

describe("ownVaultDestinations — own OTHER writable, unlent scopes", () => {
  it("excludes the current scope, read-only scopes, and anything borrowed", () => {
    const listed = shareKit.ownVaultDestinations(
      [OWN, FAMILY, READ_ONLY, BORROWED],
      "own"
    );
    expect(listed.map((d: ShareDestination) => d.id)).toStrictEqual(["fam"]);
  });

  it("answers nothing on a solo mount", () => {
    expect(shareKit.ownVaultDestinations([OWN], "own")).toStrictEqual([]);
  });
});

describe("linkedDestinations — approved links not already mounted", () => {
  it("names the OTHER side of the link, best-effort labelled", () => {
    const links: LinkRow[] = [
      { linkId: "l1", vaultId: "peer-1", approved: true },
    ];
    const listed = shareKit.linkedDestinations(links, [OWN]);
    expect(listed).toStrictEqual([
      { id: "peer-1", label: "Linked vault peer-1" },
    ]);
  });

  it("excludes a link whose vault is already mounted (e.g. already borrowed) — never listed twice", () => {
    const links: LinkRow[] = [
      { linkId: "l1", vaultId: "lent", approved: true },
    ];
    expect(shareKit.linkedDestinations(links, [OWN, BORROWED])).toStrictEqual(
      []
    );
  });

  it("excludes an unapproved or revoked link", () => {
    const links: LinkRow[] = [
      { linkId: "l1", vaultId: "peer-1", approved: false },
    ];
    expect(shareKit.linkedDestinations(links, [OWN])).toStrictEqual([]);
  });
});

describe("shareDestinations — ONE list, own vaults then linked people", () => {
  it("concatenates without re-sorting or grouping by locality", () => {
    const links: LinkRow[] = [
      { linkId: "l1", vaultId: "peer-1", approved: true },
    ];
    const listed = shareKit.shareDestinations([OWN, FAMILY], "own", links);
    expect(listed.map((d: ShareDestination) => d.id)).toStrictEqual([
      "fam",
      "peer-1",
    ]);
  });
});

describe("shareBlockedReason", () => {
  it("states the honest zero-destination reason", () => {
    expect(shareKit.shareBlockedReason([])).toBe(
      "There is nowhere to share to yet — no other vault, and nobody linked."
    );
  });

  it("never blocks on two or more destinations — the sheet lists all of them", () => {
    expect(
      shareKit.shareBlockedReason([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ])
    ).toBeNull();
  });
});

describe("loadShareDestinations — live window.centraid.links()", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("merges own vaults with a live links() answer", async () => {
    (globalThis as { window?: unknown }).window = {
      centraid: {
        links: () =>
          Promise.resolve([
            { linkId: "l1", vaultId: "peer-1", approved: true },
          ]),
      },
    };
    const listed = await shareKit.loadShareDestinations("own", [OWN, FAMILY]);
    expect(listed.map((d: ShareDestination) => d.id)).toStrictEqual([
      "fam",
      "peer-1",
    ]);
  });

  it("degrades to own-vaults-only when the host has no link plane", async () => {
    (globalThis as { window?: unknown }).window = { centraid: {} };
    const listed = await shareKit.loadShareDestinations("own", [OWN, FAMILY]);
    expect(listed.map((d: ShareDestination) => d.id)).toStrictEqual(["fam"]);
  });
});

describe("wholeLibraryLendScope", () => {
  it("splits the app's primary minted family into schema/table", () => {
    expect(
      shareKit.wholeLibraryLendScope(["media.media_asset", "core.collection"])
    ).toStrictEqual([{ schema: "media", table: "media_asset" }]);
  });

  it("answers nothing for a declaration with no minted families", () => {
    expect(shareKit.wholeLibraryLendScope([])).toStrictEqual([]);
  });
});

describe("searchReachWarning — the mask-selection-time half of D10", () => {
  it("is null when no scope masks any searchable column", () => {
    expect(
      shareKit.searchReachWarning(
        [
          {
            schema: "media",
            table: "media_asset",
            masksSearchableColumns: false,
          },
        ],
        "Priya"
      )
    ).toBeNull();
  });

  it("is null when the edges response carried no reach at all (an older gateway, or a build with no signer)", () => {
    expect(shareKit.searchReachWarning(undefined, "Priya")).toBeNull();
  });

  it("names the destination and the narrowed table when a scope masks a searchable column", () => {
    const warning = shareKit.searchReachWarning(
      [{ schema: "media", table: "media_asset", masksSearchableColumns: true }],
      "Priya"
    );
    expect(warning).toContain("Priya");
    expect(warning).toContain("media_asset");
  });

  it("is empty for an empty reach array — nothing was lent, nothing to warn about", () => {
    expect(shareKit.searchReachWarning([], "Priya")).toBeNull();
  });
});

describe("wording (D7)", () => {
  it("never says 'take back' for a lend, and warns a give is irrevocable", () => {
    expect(shareKit.STOP_LENDING_LABEL.toLowerCase()).not.toContain(
      "take back"
    );
    expect(shareKit.STOP_LENDING_LABEL).toBe("Stop lending");
    expect(shareKit.GIVE_IRREVOCABLE_WARNING.toLowerCase()).toContain(
      "can’t take it back"
    );
  });
});
