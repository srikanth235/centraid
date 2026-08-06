/*
 * The default share DESTINATION (issue #711 item H, Photos v4 handoff §H).
 *
 * SHARING IS NOT A PROPERTY OF A VAULT. A member may well want to share
 * photographs into several places — the household's shared vault today, a
 * project vault tomorrow — so "the sharing vault" is not a fact about any
 * vault record. It is a CHOICE OF DESTINATION, held by the person doing the
 * sharing. Baking it into `core_vault` as a kind enum would freeze one app's
 * UX into the core ontology and cap the household at one shared place
 * forever; a pointer costs nothing and can be re-aimed.
 *
 * SO IT LIVES HERE, as a POINTER, on the gateway's existing preference plane
 * (`gateway.db`'s `prefs` table — the same key/value bag `agent.runner.kind`
 * and `model.<runner>.<subsystem>` use). No new plane, no new table:
 *
 *   share.defaultTargetVaultId                        the ACCOUNT default
 *   member.<memberId>.share.defaultTargetVaultId      one member's override
 *
 * The account default is written once, at founding, pointing at the "Shared"
 * vault the account is created with — so Copy to Sharing has a destination on
 * day one without anybody configuring anything. A member who wants their own
 * destination gets a row of their own; resolution is override-then-default,
 * and nothing is ever inferred from a vault's NAME or creation order.
 *
 * IT STORES AN ID, so renaming the destination (or renaming some OTHER vault
 * to "Sharing") changes nothing: the pointer keeps naming the same place, and
 * a vault that merely calls itself Sharing never becomes one.
 *
 * A pointer can dangle — the destination may be deleted, or a given member may
 * hold no role in it. That is deliberately NOT resolved away here: the value is
 * reported as stored, and the client renders the action disabled with the
 * reason inline (the read-only pattern) rather than silently doing nothing.
 */

import type { GatewayDatabase } from "./gateway-db.js";

/** The account-wide default destination — written at founding. */
export const ACCOUNT_SHARE_TARGET_PREF = "share.defaultTargetVaultId";

/** One member's own destination, which outranks the account default. */
export function memberShareTargetPref(memberId: string): string {
  return `member.${memberId}.share.defaultTargetVaultId`;
}

function readPrefString(
  gatewayDatabase: GatewayDatabase,
  key: string
): string | undefined {
  const row = gatewayDatabase.prefRows().find((entry) => entry.key === key);
  if (!row) return undefined;
  try {
    const value: unknown = JSON.parse(row.value_json);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    // A hand-edited or truncated row is "no pointer", never a crash on a
    // read path every scope listing goes through.
    return undefined;
  }
}

/**
 * Where this member's shares land by default: their own pointer if they have
 * one, else the account's. `undefined` means nothing has ever been pointed at
 * — an account founded before this existed, or one whose pointer was cleared.
 */
export function readDefaultShareTarget(
  gatewayDatabase: GatewayDatabase,
  memberId?: string
): string | undefined {
  const own = memberId
    ? readPrefString(gatewayDatabase, memberShareTargetPref(memberId))
    : undefined;
  return own ?? readPrefString(gatewayDatabase, ACCOUNT_SHARE_TARGET_PREF);
}

/**
 * Aim the pointer. With no `memberId` this sets the ACCOUNT default (what
 * founding does); with one it sets that member's override, leaving everybody
 * else on the account default.
 */
export function writeDefaultShareTarget(
  gatewayDatabase: GatewayDatabase,
  vaultId: string,
  memberId?: string
): void {
  gatewayDatabase.setPref(
    memberId ? memberShareTargetPref(memberId) : ACCOUNT_SHARE_TARGET_PREF,
    vaultId
  );
}
