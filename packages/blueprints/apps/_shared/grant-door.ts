/**
 * ONE WRITE DOOR OVER THE GRANT PLANE (#825).
 *
 * Seats supply transport only; parsing and every sentence a member reads are
 * decided here. Route messages are reported verbatim. A 404 is an answer
 * (`known: false`), not a read failure.
 */

import { GRANT_FAILED, REVOKE_FAILED } from "./grant-copy.ts";
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

/** `readable` keeps "refused" distinct from "could not ask". */
export interface SubjectRegistry {
  readable: boolean;
  offers: GrantSubjectOffer[];
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
  | { ok: false; message: string };

export type GrantRevokeOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

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

function refusal(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length ? message : fallback;
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
      } catch {
        return { readable: false, offers: [] };
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
        return { ok: false, message: refusal(error, GRANT_FAILED) };
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
        return { ok: false, message: refusal(error, REVOKE_FAILED) };
      }
    },
  };
}
