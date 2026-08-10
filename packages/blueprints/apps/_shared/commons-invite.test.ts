import { describe, expect, it } from "vitest";

import {
  commonsInviteMessage,
  encodeCommonsInvite,
  parseCommonsInvite,
} from "./commons-invite.ts";

describe("Commons one-time invite handoff", () => {
  it("round-trips an opaque claim without putting it outside the URI", () => {
    const uri = encodeCommonsInvite({
      stewardVaultId: "vault/steward",
      claimToken: "one-time_token-._~",
    });

    expect(parseCommonsInvite(uri)).toStrictEqual({
      stewardVaultId: "vault/steward",
      claimToken: "one-time_token-._~",
    });
    expect(commonsInviteMessage(uri)).toContain("create your vault");
    expect(commonsInviteMessage(uri)).toContain("connect with them first");
    expect(commonsInviteMessage(uri)).toContain("then Accept or Refuse");
  });

  it("refuses unrelated or incomplete text", () => {
    expect(parseCommonsInvite("claim-token-alone")).toBeNull();
    expect(
      parseCommonsInvite(
        "centraid://commons-invite?v=1&stewardVaultId=vault-only"
      )
    ).toBeNull();
  });
});
