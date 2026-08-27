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
    expect(commonsInviteMessage(uri)).toContain("then Accept or Refuse");
  });

  it("states the same-gateway limit rather than a way around it", () => {
    // #825: a grant to a party whose vault lives on another gateway parks at
    // `syncing` forever. "Connect with them first" named a ceremony that
    // cannot make the delivery happen, so the message says the limit instead.
    const message = commonsInviteMessage(
      encodeCommonsInvite({ stewardVaultId: "vault-a", claimToken: "tok" })
    );
    expect(message).toContain("same gateway as theirs");
    expect(message).not.toContain("connect with them first");
    expect(message).not.toContain("another gateway");
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
