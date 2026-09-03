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

export interface SubjectRegistry {
  readable: boolean;
  offers: GrantSubjectOffer[];
  reach?: GrantFailureReach;
  loci?: Partial<Record<GrantLocus, string>>;
}

export interface AudienceGrants {
  known: boolean;
  grants: GrantRecord[];
}

export type GrantCreateOutcome =
  | { ok: true; outcome: "created" | "exists"; grant?: GrantRecord }
  | { ok: true; outcome: "awaiting_confirmation"; message: string }
  | { ok: true; outcome: "queued"; message: string }
  | { ok: false; message: string; reach: GrantFailureReach };

export type GrantRevokeOutcome =
  | {
      ok: true;
      message: string;
      promise?: string;
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
        if (isQueuedGrantAnswer(answer))
          return { ok: true, outcome: "queued", message: GRANT_QUEUED };
        const out = body(answer);
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
