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

export function commonsInviteMessage(inviteUri: string): string {
  return [
    "Centraid shared-space invitation",
    "",
    "1. Install Centraid and create your vault.",
    "2. If the sharer is on another gateway, connect with them first.",
    "3. In People & circles, paste and redeem this invitation.",
    "4. Review its current size, then Accept or Refuse.",
    "",
    inviteUri,
  ].join("\n");
}
