/**
 * ONE WRITE DOOR OVER THE GRANT PLANE (issue #825).
 *
 * Each seat can only reach the gateway its own way — the web blueprint kit
 * through the shell's `window.centraid` bridge (the PWA rides an iroh tunnel,
 * so a bare `fetch` of a gateway path resolves nowhere), native through its
 * authed base URL. That difference is a TRANSPORT difference and nothing else,
 * so it is the only thing a seat supplies: `GrantWireCalls`. Everything the
 * member's answer depends on — how a payload is parsed, which refusal is
 * shown, what "already shared" means, what a revoke says afterwards — is
 * decided once, here, for both seats.
 *
 * The refusal contract, in particular, is not per seat: a subject the vault
 * has no strategy for is refused with the route's OWN message (it names the
 * capabilities that subject does answer), and a revoke reports the route's
 * derived sentence verbatim rather than a local paraphrase.
 */

import { GRANT_FAILED, REVOKE_FAILED } from "./grant-copy.ts";
import type {
  GrantAudienceKind,
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
 * The transport each seat supplies. Every call answers the route's parsed JSON
 * body as `unknown` — the parsing law belongs to this module, not to a seat —
 * and rejects with an `Error` whose `message` is the route's own `message`
 * when it sent one.
 */
export interface GrantWireCalls {
  /** `GET …/grants/subjects` — the declared registry. */
  subjects: () => Promise<unknown>;
  /** `GET …/grants?partyId=` — the G-audience union plus the channel. */
  forParty: (partyId: string) => Promise<unknown>;
  /** `GET …/grants?audienceKind=&audienceId=`; `undefined` for a 404. */
  forAudience: (
    kind: GrantAudienceKind,
    id: string
  ) => Promise<unknown | undefined>;
  /** `GET …/grants?subjectType=&subjectId=` — the object side. */
  forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
  /** `POST …/grants`. */
  create: (request: GrantRequest) => Promise<unknown>;
  /** `POST …/grants/<id>/revoke`. */
  revoke: (grantId: string) => Promise<unknown>;
}

/** What a person can reach, and whether this vault can reach them at all. */
export interface PartyReach {
  channel: GrantChannel;
  grants: GrantRecord[];
}

/**
 * The literal audience read. `known: false` is a party or circle the vault has
 * no record of — distinct from an audience with nothing shared, which answers
 * `known: true` and an empty list.
 */
export interface AudienceGrants {
  known: boolean;
  grants: GrantRecord[];
}

export type GrantCreateOutcome =
  | { ok: true; outcome: "created" | "exists"; grant?: GrantRecord }
  | { ok: false; message: string };

export type GrantRevokeOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

export interface GrantDoor {
  subjects: () => Promise<GrantSubjectOffer[]>;
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

/** A refusal in the member's words: the route's own message, or the fallback. */
function refusal(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length ? message : fallback;
}

export function grantDoor(calls: GrantWireCalls): GrantDoor {
  return {
    async subjects() {
      // A registry that cannot be read is an EMPTY registry, never an open
      // one: a surface that guessed here would offer a verb the vault has no
      // strategy for and record a grant it could not keep.
      try {
        return parseSubjectOffers(body(await calls.subjects()).subjects);
      } catch {
        return [];
      }
    },

    async forParty(partyId) {
      const out = body(await calls.forParty(partyId));
      return {
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
        // `exists` is the honest answer to saying the same sentence twice, and
        // it is a success: the grant the member asked for is standing.
        const outcome = out.outcome === "exists" ? "exists" : "created";
        const grant = parseGrant(out.grant);
        return { ok: true, outcome, ...(grant ? { grant } : {}) };
      } catch (error) {
        return { ok: false, message: refusal(error, GRANT_FAILED) };
      }
    },

    async revoke(grantId) {
      try {
        const out = body(await calls.revoke(grantId));
        // The route DERIVES this sentence from what each delivered copy did.
        // Rendering anything else here would flatten three honest answers into
        // one optimistic one, which is the failure `revocationMessage` exists
        // to prevent.
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
