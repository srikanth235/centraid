/*
 * Who may invite whom, at what authority (issue #599 Decision 5).
 *
 * Minting splits by TARGET, not by role:
 *
 *   self-pair — any enrolled member may mint a ticket for THEMSELVES, at
 *               roles they already hold. "Ask your spouse for a QR to pair
 *               your own new phone" fails the family test.
 *   invite    — minting for another person is an ownership act, so the
 *               caller must be `admin` in EVERY vault the ticket grants.
 *
 * The host-custody lane (landlord bearer on the loopback socket) is L0 root
 * and may mint anything; it is the local recovery path and the only way back
 * in after every device is lost.
 *
 * A joining device never names its own member or roles — this module decides
 * both, and `PairingTicketStore.mint` burns the decision into the ticket.
 */

import type {
  EnrollmentStore,
  GrantableRole,
} from "../serve/enrollment-store.js";
import { roleWithin } from "../serve/enrollment-store.js";
import type { MemberGrant } from "../serve/member-store.js";

export interface InvitationRefusal {
  error: string;
  message: string;
  status: number;
}

export interface Invitation {
  memberId: string;
  memberLabel: string;
  grants: MemberGrant[];
}

export type InvitationDecision = Invitation | InvitationRefusal;

/** `null` = malformed; `[]` = the caller named no explicit grant list. */
export function parseGrants(raw: unknown): MemberGrant[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const grants: MemberGrant[] = [];
  for (const entry of raw) {
    const grant = entry as { vaultId?: unknown; role?: unknown };
    if (
      typeof grant.vaultId !== "string" ||
      grant.vaultId.length === 0 ||
      (grant.role !== "admin" &&
        grant.role !== "write" &&
        grant.role !== "read")
    ) {
      return null;
    }
    grants.push({ vaultId: grant.vaultId, role: grant.role });
  }
  return grants;
}

export interface ResolveInvitationInput {
  enrollments: EnrollmentStore;
  vaultName: (vaultId: string) => string | undefined;
  callerKey: string | undefined;
  hostCustody: boolean;
  hostVaults: readonly string[];
  /** Fallback single-grant vault when the caller named no grant list. */
  target: string;
  role: GrantableRole;
  body: Record<string, unknown>;
  grants: MemberGrant[];
}

export function resolveInvitation(
  input: ResolveInvitationInput
): InvitationDecision {
  const members = input.enrollments.members;
  const callerMember = input.callerKey
    ? input.enrollments.memberFor(input.callerKey)
    : undefined;

  const requestedMember =
    typeof input.body.memberId === "string" ? input.body.memberId : undefined;
  const rawNewLabel =
    typeof input.body.newMemberLabel === "string"
      ? input.body.newMemberLabel.trim()
      : undefined;
  const newMemberLabel =
    rawNewLabel !== undefined && rawNewLabel.length > 0
      ? rawNewLabel
      : undefined;
  if (requestedMember !== undefined && newMemberLabel !== undefined) {
    return {
      status: 400,
      error: "ambiguous_member",
      message: "name an existing memberId or a newMemberLabel, never both",
    };
  }
  if (rawNewLabel !== undefined && newMemberLabel === undefined) {
    return {
      status: 400,
      error: "invalid_member_label",
      message: "newMemberLabel must not be blank",
    };
  }

  // The picker never sends free text for an existing person: `memberId`
  // resolves an id (or an exact label, for the CLI's `--member`) and 404s
  // otherwise, so a typo can never mint a phantom member with live access.
  const hostDefaultOwner =
    input.hostCustody &&
    requestedMember === undefined &&
    newMemberLabel === undefined
      ? members.adminsOf(input.target).map((id) => members.get(id))[0]
      : undefined;
  const existing =
    requestedMember === undefined
      ? newMemberLabel
        ? undefined
        : (callerMember ?? hostDefaultOwner)
      : members.find(requestedMember);
  if (requestedMember !== undefined && !existing) {
    return {
      status: 404,
      error: "member_not_found",
      message: `no member matches "${requestedMember}"`,
    };
  }
  const isSelfPair =
    existing !== undefined && existing.memberId === callerMember?.memberId;

  const grants =
    input.grants.length > 0
      ? input.grants
      : (isSelfPair && callerMember) || hostDefaultOwner
        ? members.grants(existing!.memberId)
        : [{ vaultId: input.target, role: input.role }];
  if (grants.length === 0) {
    return {
      status: 400,
      error: "grants_required",
      message: "an invitation must grant at least one vault role",
    };
  }
  for (const grant of grants) {
    if (input.vaultName(grant.vaultId) === undefined) {
      return {
        status: 404,
        error: "not_found",
        message: "unknown vault in grants",
      };
    }
  }

  if (!input.hostCustody) {
    if (!callerMember) {
      return {
        status: 403,
        error: "device_identity_required",
        message:
          "pairing tickets require an enrolled device or direct host custody",
      };
    }
    for (const grant of grants) {
      const own = members.roleIn(callerMember.memberId, grant.vaultId);
      if (isSelfPair) {
        // Self-pair is bounded by what you already hold — a `write` member
        // cannot promote themselves by pairing a second phone.
        if (!own || !roleWithin(grant.role, own)) {
          return {
            status: 403,
            error: "role_above_own",
            message:
              "a self-pairing ticket cannot grant more than the member already holds",
          };
        }
      } else if (own !== "admin") {
        return {
          status: 403,
          error: "not_admin",
          message:
            "inviting another person requires admin in every granted vault",
        };
      }
    }
  }

  const member =
    existing ?? members.create(newMemberLabel ?? defaultMemberLabel(input));
  return { memberId: member.memberId, memberLabel: member.label, grants };
}

function defaultMemberLabel(input: ResolveInvitationInput): string {
  const vaultName = input.vaultName(input.target);
  return vaultName ? `New member (${vaultName})` : "New member";
}
