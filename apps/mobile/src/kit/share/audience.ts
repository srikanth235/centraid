// P7 — the grant roster read, mobile side (issue #712, folded into Engine A
// by default ruling). "Who can see vault X" had no answer anywhere before
// this: `packages/gateway/src/serve/member-store.ts`'s new `membersOf` and
// `scopes-routes.ts`'s new `audience` field give WEB an answer, threaded
// gateway → `useAppScopes.ts` → `InlineScope.audience`. Mobile's mounted-scope
// model (`kit/replica/ReplicaProvider.tsx`) carries no such field, so this
// reads the SAME fact straight off the household roster route — the pattern
// `lib/gateway.ts`'s `readSelfMemberName` and `kit/transfer/transfer-queue.ts`
// already use for a one-shot gateway HTTP read outside the replica.
import { apiHeaders, fetchJson, requireGatewayBase } from "../../lib/gateway";

/** One person who can see a vault, and the role they hold there. Mirrors the
 *  gateway route's `audience` row shape exactly (`ScopesBody.scopes[].audience`). */
export interface AudienceMember {
  memberId: string;
  name: string;
  role: string;
}

interface MembersResponseRow {
  memberId: string;
  label: string;
  roles?: Array<{ vaultId: string; role: string }>;
}

interface MembersResponse {
  members?: MembersResponseRow[];
}

/**
 * Everyone who holds a role in `vaultId`, read off the household roster the
 * caller can already see. `GET /_gateway/members` (`members-routes.ts`)
 * already answers only members who share a vault with the caller, so nothing
 * here can leak topology the caller could not otherwise reach.
 *
 * `[]` on a gateway with no device plane (the route 404s, same as
 * `listGatewayMembers` on web) or a transient failure: the roster is a
 * nice-to-know for a Sharing surface, never a blocking read, so a network
 * hiccup empties the list rather than failing whatever screen asked.
 */
export async function vaultAudience(
  vaultId: string
): Promise<AudienceMember[]> {
  try {
    const base = await requireGatewayBase();
    const body = await fetchJson<MembersResponse>(
      `${base}/centraid/_gateway/members`,
      { headers: apiHeaders(), method: "GET" }
    );
    return (body.members ?? []).flatMap((member) =>
      (member.roles ?? [])
        .filter((grant) => grant.vaultId === vaultId)
        .map((grant) => ({
          memberId: member.memberId,
          name: member.label,
          role: grant.role,
        }))
    );
  } catch {
    return [];
  }
}
