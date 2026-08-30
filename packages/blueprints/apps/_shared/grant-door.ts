/**
 * ONE WRITE DOOR OVER THE GRANT PLANE (#825). Seats supply transport only;
 * parsing and every sentence a member reads are decided here. Route messages
 * are reported verbatim; a 404 is an answer (`known: false`), not a read
 * failure.
 */

import {
  GRANT_AWAITING_CONFIRMATION,
  GRANT_FAILED,
  GRANT_QUEUED,
  GRANT_UNREACHABLE,
  REVOKE_FAILED,
  REVOKE_QUEUED,
  REVOKE_UNREACHABLE,
} from "./grant-copy.ts";
import type {
  GrantAudienceKind,
  GrantChannel,
  GrantLocus,
  GrantRecord,
  GrantRequest,
  GrantSubject,
  GrantSubjectOffer,
} from "./grant-plane.ts";
import {
  parseChannel,
  parseGrant,
  parseGrants,
  parseLoci,
  parseSubjectOffers,
} from "./grant-plane.ts";
import { isGrantUnreachable, isQueuedGrantAnswer } from "./grant-transport.ts";
import type { GrantWireCalls } from "./grant-transport.ts";

/* Re-exported from `grant-transport.ts`, which a seat can import without this
 * file's relative imports; readers of the door keep one import site. */
export {
  GrantUnreachableError,
  isGrantUnreachable,
} from "./grant-transport.ts";
export type { GrantWireCalls } from "./grant-transport.ts";

export type GrantFailureReach = "unreachable" | "refused";

const AWAITING_CONFIRMATION = "awaiting_confirmation";

export interface PartyReach {
  known: boolean;
  channel: GrantChannel;
  grants: GrantRecord[];
}

/** `reach` tells the two ways of not-asking apart; absent when `readable`. */
export interface SubjectRegistry {
  readable: boolean;
  offers: GrantSubjectOffer[];
  reach?: GrantFailureReach;
  /** Per-locus revoke promise in the vault's own words (ruling V-locus), for a
   *  replica dashboard with no route body; absent means print nothing. */
  loci?: Partial<Record<GrantLocus, string>>;
}

export interface AudienceGrants {
  known: boolean;
  grants: GrantRecord[];
}

/** `exists` is the same answer read back, never a widening. */
export type GrantCreateOutcome =
  | { ok: true; outcome: "created" | "exists"; grant?: GrantRecord }
  | { ok: true; outcome: "awaiting_confirmation"; message: string }
  /** Held durably by the seat's queue (#883) — neither refused nor landed. */
  | { ok: true; outcome: "queued"; message: string }
  | { ok: false; message: string; reach: GrantFailureReach };

export type GrantRevokeOutcome =
  | {
      ok: true;
      message: string;
      promise?: string;
      /** Held, not yet asked of the audience (#883). No `promise` rides with
       *  it: the route has not spoken, and this door speaks for no vault. */
      queued?: true;
    }
  | { ok: false; message: string; reach: GrantFailureReach };

export interface GrantDoor {
  subjects: () => Promise<SubjectRegistry>;
  forParty: (partyId: string) => Promise<PartyReach>;
  forAudience: (kind: GrantAudienceKind, id: string) => Promise<AudienceGrants>;
  forSubject: (subject: GrantSubject) => Promise<GrantRecord[]>;
  create: (request: GrantRequest) => Promise<GrantCreateOutcome>;
  revoke: (grantId: string) => Promise<GrantRevokeOutcome>;
  /** WITHDRAW then GRANT — the only change the plane allows (ruling V-table),
   *  ordered and stopping at the first refusal. The withdrawal is real while it
   *  runs, so a surface states that cost first. */
  changeCapability: (
    grantId: string,
    request: GrantRequest
  ) => Promise<GrantCreateOutcome>;
}

function body(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** An unreachable gateway said NOTHING, and the transport's internal message
 *  is not member-facing copy. A refusal keeps the route's words. */
function outcomeMessage(
  error: unknown,
  refused: string,
  unreachable: string
): { message: string; reach: GrantFailureReach } {
  if (isGrantUnreachable(error))
    return { message: unreachable, reach: "unreachable" };
  const message = error instanceof Error ? error.message.trim() : "";
  return { message: message.length ? message : refused, reach: "refused" };
}

export function grantDoor(calls: GrantWireCalls): GrantDoor {
  const door: GrantDoor = {
    async subjects() {
      // Never guess offers on a read failure — it offers verbs the vault lacks.
      try {
        const answer = body(await calls.subjects());
        return {
          readable: true,
          offers: parseSubjectOffers(answer.subjects),
          loci: parseLoci(answer.loci),
        };
      } catch (error) {
        return {
          readable: false,
          offers: [],
          reach: isGrantUnreachable(error) ? "unreachable" : "refused",
        };
      }
    },

    async forParty(partyId) {
      const answer = await calls.forParty(partyId);
      if (answer === undefined)
        return { known: false, channel: undefined, grants: [] };
      const out = body(answer);
      return {
        known: true,
        channel: parseChannel(out.channel),
        grants: parseGrants(out.grants),
      };
    },

    async forAudience(kind, id) {
      const answer = await calls.forAudience(kind, id);
      if (answer === undefined) return { known: false, grants: [] };
      return { known: true, grants: parseGrants(body(answer).grants) };
    },

    async forSubject(subject) {
      const out = body(
        await calls.forSubject(subject.subjectType, subject.subjectId)
      );
      return parseGrants(out.grants);
    },

    async create(request) {
      try {
        const answer = await calls.create(request);
        // The queued mark is the transport's, never inferred here.
        if (isQueuedGrantAnswer(answer))
          return { ok: true, outcome: "queued", message: GRANT_QUEUED };
        const out = body(answer);
        // A 2xx: only the body tells a parked ask from a grant that landed.
        if (out.error === AWAITING_CONFIRMATION)
          return {
            ok: true,
            outcome: "awaiting_confirmation",
            message:
              typeof out.message === "string" && out.message.length
                ? out.message
                : GRANT_AWAITING_CONFIRMATION,
          };
        const outcome = out.outcome === "exists" ? "exists" : "created";
        const grant = parseGrant(out.grant);
        return { ok: true, outcome, ...(grant ? { grant } : {}) };
      } catch (error) {
        return {
          ok: false,
          ...outcomeMessage(error, GRANT_FAILED, GRANT_UNREACHABLE),
        };
      }
    },

    async revoke(grantId) {
      try {
        const answer = await calls.revoke(grantId);
        if (isQueuedGrantAnswer(answer))
          return { ok: true, queued: true, message: REVOKE_QUEUED };
        const out = body(answer);
        const message =
          typeof out.message === "string" && out.message.length
            ? out.message
            : REVOKE_FAILED;
        // Only where the route sent one — this door invents no promises.
        const promise =
          typeof out.promise === "string" && out.promise.length
            ? out.promise
            : undefined;
        return { ok: true, message, ...(promise ? { promise } : {}) };
      } catch (error) {
        return {
          ok: false,
          ...outcomeMessage(error, REVOKE_FAILED, REVOKE_UNREACHABLE),
        };
      }
    },

    async changeCapability(grantId, request) {
      const withdrawn = await door.revoke(grantId);
      if (!withdrawn.ok)
        return {
          ok: false,
          message: withdrawn.message,
          reach: withdrawn.reach,
        };
      return door.create(request);
    },
  };
  return door;
}
