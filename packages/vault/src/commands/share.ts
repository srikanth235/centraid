// The `share.*` command pack (#883 V-writer): the ONE writer of the share half
// of the authority plane. The plane's other principals already had receipted
// doors — `enrich.record_consent` is a gateway command, and a device's row is
// written by ENROLLMENT, a host ceremony that runs before there is a gateway.
//
// The plane's vocabulary is `principal`/`verb`; the share wire's is
// `audience`/`capability` (#825). They meet in `grant-store.ts` — this pack
// speaks the plane's, and the route translates once at the edge.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import {
  isRegisteredAuthority,
  registeredVerbs,
} from "../grant/authority-registry.js";
import {
  createShareGrant,
  declineShare,
  readShareGrant,
  revokeShareGrant,
} from "../grant/grant-store.js";
import type {
  ShareGrantAudience,
  ShareGrantAudienceKind,
  ShareGrantCapability,
} from "../grant/grant-store.js";
import { unregisteredVerbCopy, verbConflictCopy } from "../grant/phrases.js";
import type { ShareableItemType } from "../share/closure.js";

const PRINCIPAL_OF_AUDIENCE: Readonly<
  Record<ShareGrantAudienceKind, "person" | "circle">
> = { party: "person", circle: "circle" };

interface ShareInput {
  audience_kind: ShareGrantAudienceKind;
  audience_id: string;
  subject_type: string;
  subject_id: string;
  verb?: string;
}

const AUDIENCE_PROPERTIES = {
  audience_kind: { type: "string", enum: ["party", "circle"] },
  audience_id: { type: "string", minLength: 1 },
  subject_type: { type: "string", minLength: 1 },
  subject_id: { type: "string", minLength: 1 },
  verb: { type: "string", minLength: 1, maxLength: 64 },
} as const;

const AUDIENCE_REQUIRED = [
  "audience_kind",
  "audience_id",
  "subject_type",
  "subject_id",
] as const;

function answeringParty(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

// The registry gate (V-registry): a triple with no strategy is refused HERE,
// never left standing in the table as a promise nothing keeps.
function registered(input: ShareInput): {
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  verb: ShareGrantCapability;
} {
  const verb = input.verb ?? "view";
  const principalKind = PRINCIPAL_OF_AUDIENCE[input.audience_kind];
  if (!isRegisteredAuthority(principalKind, input.subject_type, verb))
    throw new Error(
      unregisteredVerbCopy({
        subjectType: input.subject_type,
        verb,
        offered: registeredVerbs(principalKind, input.subject_type),
      })
    );
  return {
    audience: { kind: input.audience_kind, id: input.audience_id },
    // The registry answered for this pair, so both narrowings are its answer.
    subjectType: input.subject_type as ShareableItemType,
    verb: verb as ShareGrantCapability,
  };
}

const GRANT: CommandDefinition = {
  name: "share.grant",
  ownerSchema: "share",
  inputSchema: {
    type: "object",
    required: [...AUDIENCE_REQUIRED],
    additionalProperties: false,
    properties: {
      ...AUDIENCE_PROPERTIES,
      /** Delivery-strategy config, not part of the answer (ruling V-delivery). */
      max_size_bytes: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["grant_id", "outcome", "verb"],
    properties: {
      grant_id: { type: "string" },
      outcome: { type: "string" },
      verb: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: "answer_stands",
      sql: `SELECT count(*) AS n FROM share_authority
             WHERE authority_id = :grant_id AND decision = 'granted'
               AND revoked_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  // Salience (#306 decision 2), not a gate. `confirm` parks every non-owner
  // caller: an app may propose a share, only the member says it.
  risk: "high",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as unknown as ShareInput & {
      max_size_bytes?: number;
    };
    const asked = registered(input);
    const created = createShareGrant(ctx.db, {
      audience: asked.audience,
      subjectType: asked.subjectType,
      subjectId: input.subject_id,
      capability: asked.verb,
      grantedAt: ctx.now,
      grantedBy: answeringParty(ctx),
      ...(input.max_size_bytes === undefined
        ? {}
        : { maxSizeBytes: input.max_size_bytes }),
    });
    if (created.outcome === "conflict")
      throw new Error(
        verbConflictCopy({
          subjectType: input.subject_type,
          standingVerb: created.grant.capability,
          verb: asked.verb,
        })
      );
    ctx.wrote("share.authority", created.grantId);
    // Only a NEW answer is a decision; receipting a repeat would inflate the
    // stream "last used" is counted from (ruling V-receipts).
    if (created.outcome === "created") {
      ctx.receipt({
        grantId: created.grantId,
        action: "act share.grant",
        objectType: "share.authority",
        objectId: created.grantId,
        decision: "allow",
        detail: {
          principalKind: PRINCIPAL_OF_AUDIENCE[input.audience_kind],
          principalId: input.audience_id,
          subjectType: input.subject_type,
          subjectId: input.subject_id,
          verb: asked.verb,
          decisionRecorded: "granted",
        },
      });
      ctx.cite({
        claim: `shared ${input.subject_type} ${input.subject_id} for ${asked.verb}`,
        entityType: input.subject_type,
        entityId: input.subject_id,
      });
    }
    return {
      grant_id: created.grantId,
      outcome: created.outcome,
      verb: asked.verb,
    };
  },
};

const REVOKE: CommandDefinition = {
  name: "share.revoke",
  ownerSchema: "share",
  inputSchema: {
    type: "object",
    required: ["grant_id"],
    additionalProperties: false,
    properties: { grant_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["grant_id", "outcome"],
    properties: {
      grant_id: { type: "string" },
      outcome: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      // Absent revokes cleanly too: nothing may STAND under this id afterwards.
      name: "answer_no_longer_stands",
      sql: `SELECT count(*) AS n FROM share_authority
             WHERE authority_id = :grant_id AND revoked_at IS NULL`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "idempotent",
  risk: "high",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as { grant_id: string };
    const before = readShareGrant(ctx.db, input.grant_id);
    const revoked = revokeShareGrant(ctx.db, {
      grantId: input.grant_id,
      revokedAt: ctx.now,
    });
    if (revoked.outcome === "revoked") {
      ctx.wrote("share.authority", input.grant_id);
      ctx.receipt({
        grantId: input.grant_id,
        action: "act share.revoke",
        objectType: "share.authority",
        objectId: input.grant_id,
        decision: "allow",
        detail: {
          ...(before
            ? {
                subjectType: before.subjectType,
                subjectId: before.subjectId,
                verb: before.capability,
                principalId: before.audience.id,
              }
            : {}),
          // The record that these copies were owed back when the answer ended.
          deliveredTo: revoked.fulfillment
            .filter((row) => row.deliveredAt !== null)
            .map((row) => row.peerVaultId),
        },
      });
    }
    return { grant_id: input.grant_id, outcome: revoked.outcome };
  },
};

const DECLINE: CommandDefinition = {
  name: "share.decline",
  ownerSchema: "share",
  inputSchema: {
    type: "object",
    required: [...AUDIENCE_REQUIRED],
    additionalProperties: false,
    properties: { ...AUDIENCE_PROPERTIES },
  },
  outputSchema: {
    type: "object",
    required: ["authority_id", "outcome"],
    properties: {
      authority_id: { type: "string" },
      outcome: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: "refusal_stands",
      sql: `SELECT count(*) AS n FROM share_authority
             WHERE authority_id = :authority_id AND decision = 'declined'
               AND revoked_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "medium",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as unknown as ShareInput;
    const asked = registered(input);
    const declined = declineShare(ctx.db, {
      audience: asked.audience,
      subjectType: asked.subjectType,
      subjectId: input.subject_id,
      capability: asked.verb,
      decidedAt: ctx.now,
      decidedBy: answeringParty(ctx),
    });
    ctx.wrote("share.authority", declined.authorityId);
    if (declined.outcome === "declined")
      ctx.receipt({
        grantId: declined.authorityId,
        action: "act share.decline",
        objectType: "share.authority",
        objectId: declined.authorityId,
        decision: "allow",
        detail: {
          principalKind: PRINCIPAL_OF_AUDIENCE[input.audience_kind],
          principalId: input.audience_id,
          subjectType: input.subject_type,
          subjectId: input.subject_id,
          verb: asked.verb,
          decisionRecorded: "declined",
        },
      });
    return { authority_id: declined.authorityId, outcome: declined.outcome };
  },
};

export function registerShareCommands(gateway: Gateway): void {
  gateway.registerCommand(GRANT);
  gateway.registerCommand(REVOKE);
  gateway.registerCommand(DECLINE);
}

export const SHARE_COMMANDS = [
  "share.grant",
  "share.revoke",
  "share.decline",
] as const;
