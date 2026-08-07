// The Sharing shelf's model (#712 A5). Two rules carry the whole surface: what
// counts as "in Sharing", and when the shelf may claim a roster.

import { describe, expect, it } from "vitest";

import {
  NO_REMOVE_FROM_SHARING_REASON,
  sharedAssets,
  sharingStatusLine,
} from "./photos-sharing";

const asset = (
  id: string,
  fields: Partial<Parameters<typeof sharedAssets>[0][number]> = {}
): {
  id: string;
  deleted: boolean;
  sourceVaultId?: string;
  scopeIds?: string[];
} => ({
  id,
  deleted: false,
  ...fields,
});

describe(sharedAssets, () => {
  it("counts a row whose canonical vault IS the target", () => {
    expect(
      sharedAssets([asset("a", { sourceVaultId: "v-share" })], "v-share").map(
        (row) => row.id
      )
    ).toStrictEqual(["a"]);
  });

  it("also counts a MERGED row that is merely present in the target", () => {
    // One sha, seen in two vaults. Requiring the canonical vault to be the
    // target would make a photograph the member shared out of their own vault
    // vanish from the shelf that is supposed to prove it is shared.
    expect(
      sharedAssets(
        [
          asset("a", {
            sourceVaultId: "v-mine",
            scopeIds: ["v-mine", "v-share"],
          }),
        ],
        "v-share"
      ).map((row) => row.id)
    ).toStrictEqual(["a"]);
  });

  it("excludes trashed rows — the trash is its own shelf", () => {
    expect(
      sharedAssets(
        [asset("a", { deleted: true, sourceVaultId: "v-share" })],
        "v-share"
      )
    ).toStrictEqual([]);
  });

  it("is empty with no target — never the whole library by accident", () => {
    expect(
      sharedAssets([asset("a", { sourceVaultId: "v-share" })], undefined)
    ).toStrictEqual([]);
  });
});

describe(sharingStatusLine, () => {
  it("names the roster when there is one, in the right number", () => {
    expect(sharingStatusLine(12, 3)).toBe(
      "Sharing · 12 · 3 people hold a grant"
    );
    expect(sharingStatusLine(1, 1)).toBe(
      "Sharing · 1 · 1 person holds a grant"
    );
  });

  it("says only the count when the roster is UNANSWERED", () => {
    // `vaultAudience` answers `[]` for a gateway with no device plane, for a
    // transient failure, and before it has answered at all. None of those is
    // evidence about who can see the vault, so "0 people hold a grant" would
    // be an invented roster — and it is the sentence a member is most likely
    // to act on by sharing something they should not.
    expect(sharingStatusLine(12, 0)).toBe("Sharing · 12");
  });
});

describe("the removal refusal", () => {
  it("states the fact rather than blaming the phone", () => {
    // `PlacementIntent.kind` is `"add" | "move"` and the web's own
    // `remove-from-scope` is not a registered gateway action, so the honest
    // sentence says removal is unbuilt EVERYWHERE and offers the route that
    // does exist.
    expect(NO_REMOVE_FROM_SHARING_REASON).toContain("on any client");
    expect(NO_REMOVE_FROM_SHARING_REASON).toContain("gateway");
  });
});
