export interface CommonsInviteClaim {
  stewardVaultId: string;
  claimToken: string;
}

const INVITE_SCHEME = "centraid:";
const INVITE_HOST = "commons-invite";

/** A one-time, user-carried Commons invitation. Callers must keep this URI
 * ephemeral: copy/share it, then discard it rather than logging or storing it. */
export function encodeCommonsInvite(claim: CommonsInviteClaim): string {
  const params = new URLSearchParams({
    v: "1",
    stewardVaultId: claim.stewardVaultId,
    claimToken: claim.claimToken,
  });
  return `${INVITE_SCHEME}//${INVITE_HOST}?${params.toString()}`;
}

export function parseCommonsInvite(value: string): CommonsInviteClaim | null {
  try {
    const invite = new URL(value.trim());
    const stewardVaultId = invite.searchParams.get("stewardVaultId") ?? "";
    const claimToken = invite.searchParams.get("claimToken") ?? "";
    if (
      invite.protocol !== INVITE_SCHEME ||
      invite.host !== INVITE_HOST ||
      invite.searchParams.get("v") !== "1" ||
      !stewardVaultId ||
      !claimToken
    )
      return null;
    return { stewardVaultId, claimToken };
  } catch {
    return null;
  }
}

/* Step 2 states the v1 limit rather than a workaround for it (#825): a share
 * is fulfilled through the host's own vault registry, so both vaults have to
 * be mounted on the SAME gateway. A grant to a party whose vault lives on
 * another gateway parks at `syncing` and stays there — telling the receiver to
 * "connect first" would promise a path that does not exist yet. */
export function commonsInviteMessage(inviteUri: string): string {
  return [
    "Centraid shared-space invitation",
    "",
    "1. Install Centraid and create your vault.",
    "2. Your vault must sit on the same gateway as theirs — sharing reaches no further yet.",
    "3. In People & circles, paste and redeem this invitation.",
    "4. Review its current size, then Accept or Refuse.",
    "",
    inviteUri,
  ].join("\n");
}
