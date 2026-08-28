/**
 * ONE WRITE DOOR OVER THE GRANT PLANE (#825).
 *
 * Seats supply transport only; parsing and every sentence a member reads are
 * decided here. Route messages are reported verbatim. A 404 is an answer
 * (`known: false`), not a read failure.
 */

import {
  GRANT_FAILED,
  GRANT_UNREACHABLE,
  REVOKE_FAILED,
  REVOKE_UNREACHABLE,
} from "./grant-copy.ts";
import type {
  GrantAudienceKind,
  GrantCapability,
  GrantChannel,
  GrantRecord,
  GrantRequest,
  GrantSubject,
  GrantSubjectOffer,
} from "./grant-plane.ts";
import {
  parseChannel,
  parseGrant,
  parseGrants,
  parseSubjectOffers,
} from "./grant-plane.ts";

/**
 * The transport's own verdict, raised by a seat when the request never reached
 * the gateway. It is a MARKED error rather than an inference here, because only
 * the transport knows whether anything left the device — this door sees a
 * rejected promise either way, and guessing from the message would turn a
 * gateway's own words into an outage story or the reverse.
 */
export class GrantUnreachableError extends Error {
  readonly grantTransport = "unreachable" as const;
  constructor(op: string, cause?: unknown) {
    super(`${op}: the gateway could not be reached`, { cause });
    this.name = "GrantUnreachableError";
  }
}

/** Duck-typed on purpose: a seat bundled through a separate module graph still
 *  answers true, where `instanceof` would silently answer false. */
export function isGrantUnreachable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { grantTransport?: unknown }).grantTransport === "unreachable"
  );
}

/** Why a read or write did not land. Two words, never one. */
export type GrantFailureReach = "unreachable" | "refused";

export interface GrantWireCalls {
  subjects: () => Promise<unknown>;
  forParty: (partyId: string) => Promise<unknown | undefined>;
  forAudience: (
    kind: GrantAudienceKind,
    id: string
  ) => Promise<unknown | undefined>;
  forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
  create: (request: GrantRequest) => Promise<unknown>;
  revoke: (grantId: string) => Promise<unknown>;
}

export interface PartyReach {
  known: boolean;
  channel: GrantChannel;
  grants: GrantRecord[];
}

/** `readable` keeps "refused" distinct from "could not ask", and `reach` keeps
 *  the two ways of not-asking apart. `reach` is absent when `readable`. */
export interface SubjectRegistry {
  readable: boolean;
  offers: GrantSubjectOffer[];
  reach?: GrantFailureReach;
}

export interface AudienceGrants {
  known: boolean;
  grants: GrantRecord[];
}

/** The route says `exists` at ANY capability, so a bare "already shared" would
 * claim a widening that never happened. */
export type GrantCreateOutcome =
  | { ok: true; outcome: "created" | "exists"; grant?: GrantRecord }
  | {
      ok: true;
      outcome: "exists_other_capability";
      standing: GrantCapability;
      grant: GrantRecord;
    }
  | { ok: false; message: string; reach: GrantFailureReach };

export type GrantRevokeOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; reach: GrantFailureReach };

export interface GrantDoor {
  subjects: () => Promise<SubjectRegistry>;
  forParty: (partyId: string) => Promise<PartyReach>;
  forAudience: (kind: GrantAudienceKind, id: string) => Promise<AudienceGrants>;
  forSubject: (subject: GrantSubject) => Promise<GrantRecord[]>;
  create: (request: GrantRequest) => Promise<GrantCreateOutcome>;
  revoke: (grantId: string) => Promise<GrantRevokeOutcome>;
}

function body(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** An unreachable gateway said NOTHING, so its own words are not available to
 *  quote and the transport's internal message is not member-facing copy. A
 *  refusal keeps the route's words where it sent any. */
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
  return {
    async subjects() {
      // Never guess offers on a read failure — it offers verbs the vault lacks.
      try {
        return {
          readable: true,
          offers: parseSubjectOffers(body(await calls.subjects()).subjects),
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
        const out = body(await calls.create(request));
        const outcome = out.outcome === "exists" ? "exists" : "created";
        const grant = parseGrant(out.grant);
        if (
          outcome === "exists" &&
          grant &&
          grant.capability !== request.capability
        )
          return {
            ok: true,
            outcome: "exists_other_capability",
            standing: grant.capability,
            grant,
          };
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
        const out = body(await calls.revoke(grantId));
        const message =
          typeof out.message === "string" && out.message.length
            ? out.message
            : REVOKE_FAILED;
        return { ok: true, message };
      } catch (error) {
        return {
          ok: false,
          ...outcomeMessage(error, REVOKE_FAILED, REVOKE_UNREACHABLE),
        };
      }
    },
  };
}
