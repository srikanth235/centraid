import { evaluateAccess } from "../gateway/access.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { resolveEntity } from "../schema/tables.js";

export const RELATIONS_SCHEME_URI = "urn:duaility:relations";

export const RELATIONS_SCHEME_URI_SQL = RELATIONS_SCHEME_URI.split(":")
  .map((part) => `'${part}'`)
  .join(" || char(58) || ");

function pkOf(ctx: HandlerCtx, physical: string): string {
  const rows = ctx.db
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    pk: number;
  }[];
  const pk = rows.find((r) => r.pk === 1)?.name;
  if (!pk) throw new Error(`no primary key on ${physical}`);
  return pk;
}

function requireEndpoint(
  ctx: HandlerCtx,
  role: "from" | "to",
  type: string,
  id: string
): void {
  const ref = resolveEntity(type, ctx.db);
  if (!ref) {
    throw new Error(`${role}_type names unknown entity "${type}"`);
  }
  if (
    ref.schema === "core" &&
    (ref.table === "link" || ref.table === "link_anchor")
  ) {
    throw new Error("links do not link links");
  }
  const pk = pkOf(ctx, ref.physical);
  const live = ctx.db
    .prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`)
    .get(id);
  if (!live) throw new Error(`no ${type} with id ${id}`);
  const access = evaluateAccess(
    ctx.db,
    ctx.identity,
    ref.schema,
    ref.table,
    "read",
    ctx.purpose
  );
  if (access.decision === "deny") {
    throw new Error(`grant does not cover read of ${type}: ${access.failing}`);
  }
}

const SELECTOR_SCHEMA = {
  type: "object",
  required: ["exact", "prefix", "suffix", "start"],
  additionalProperties: false,
  properties: {
    exact: { type: "string", minLength: 1 },
    prefix: { type: "string" },
    suffix: { type: "string" },
    start: { type: "integer", minimum: 0 },
  },
} as const;

interface AnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

function writeAnchor(
  ctx: HandlerCtx,
  linkId: string,
  selector: AnchorSelector
): string {
  const existing = ctx.db
    .prepare("SELECT anchor_id FROM core_link_anchor WHERE link_id = ?")
    .get(linkId) as { anchor_id: string } | undefined;
  const json = JSON.stringify({
    exact: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    start: selector.start,
  });
  if (existing) {
    ctx.db
      .prepare(
        "UPDATE core_link_anchor SET selector_json = ? WHERE anchor_id = ?"
      )
      .run(json, existing.anchor_id);
    return existing.anchor_id;
  }
  const anchorId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link_anchor (anchor_id, link_id, selector_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(anchorId, linkId, json, ctx.now);
  return anchorId;
}

const LINK: CommandDefinition = {
  name: "core.link_entities",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["from_type", "from_id", "to_type", "to_id", "relation"],
    additionalProperties: false,
    properties: {
      from_type: { type: "string", minLength: 1 },
      from_id: { type: "string", minLength: 1 },
      to_type: { type: "string", minLength: 1 },
      to_id: { type: "string", minLength: 1 },
      relation: { type: "string", minLength: 1 },
      selector: SELECTOR_SCHEMA,
    },
  },
  outputSchema: {
    type: "object",
    required: ["link_id"],
    properties: {
      link_id: { type: "string" },
      relation_concept_id: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "relation_in_scheme",
      sql: `SELECT count(*) AS n FROM core_concept c
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE s.uri = ${RELATIONS_SCHEME_URI_SQL} AND c.notation = :relation`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "no_identical_live_link",
      sql: `SELECT count(*) AS n FROM core_link l
             JOIN core_concept c ON c.concept_id = l.relation_concept_id
            WHERE l.from_type = :from_type AND l.from_id = :from_id
              AND l.to_type = :to_type AND l.to_id = :to_id
              AND c.notation = :relation AND l.valid_to IS NULL`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "link_live",
      sql: "SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: linkEntities,
};

function linkEntities(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
    relation: string;
    selector?: AnchorSelector;
  };
  if (input.from_type === input.to_type && input.from_id === input.to_id) {
    throw new Error("an entity cannot link to itself");
  }
  requireEndpoint(ctx, "from", input.from_type, input.from_id);
  requireEndpoint(ctx, "to", input.to_type, input.to_id);
  const relation = ctx.db
    .prepare(
      `SELECT c.concept_id FROM core_concept c
        JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
       WHERE s.uri = ? AND c.notation = ?`
    )
    .get(RELATIONS_SCHEME_URI, input.relation) as
    | { concept_id: string }
    | undefined;
  if (!relation) throw new Error(`unknown relation "${input.relation}"`);
  const assertedBy =
    ctx.identity.kind === "app"
      ? "app"
      : ctx.identity.kind === "agent"
        ? "agent"
        : "owner";
  const linkId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, valid_to, asserted_by, provenance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
    )
    .run(
      linkId,
      input.from_type,
      input.from_id,
      input.to_type,
      input.to_id,
      relation.concept_id,
      ctx.now,
      assertedBy
    );
  ctx.wrote("core.link", linkId);
  if (input.selector) {
    const anchorId = writeAnchor(ctx, linkId, input.selector);
    ctx.wrote("core.link_anchor", anchorId);
  }
  ctx.cite({
    claim: `${input.from_type} ${input.from_id} —${input.relation}→ ${input.to_type} ${input.to_id}`,
    entityType: "core.link",
    entityId: linkId,
  });
  return { link_id: linkId, relation_concept_id: relation.concept_id };
}

const UNLINK: CommandDefinition = {
  name: "core.unlink_entities",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["link_id"],
    additionalProperties: false,
    properties: { link_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["link_id"],
    properties: { link_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "link_live",
      sql: "SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "link_ended",
      sql: `SELECT count(*) AS n FROM core_link
             WHERE link_id = :link_id AND valid_to IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: unlinkEntities,
};

function unlinkEntities(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { link_id: string };
  ctx.db
    .prepare("UPDATE core_link SET valid_to = ? WHERE link_id = ?")
    .run(ctx.now, input.link_id);
  ctx.wrote("core.link", input.link_id);
  return { link_id: input.link_id };
}

const ANCHOR: CommandDefinition = {
  name: "core.anchor_link",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["link_id"],
    additionalProperties: false,
    properties: {
      link_id: { type: "string", minLength: 1 },
      selector: SELECTOR_SCHEMA,
    },
  },
  outputSchema: {
    type: "object",
    required: ["link_id"],
    properties: {
      link_id: { type: "string" },
      anchor_id: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "link_live",
      sql: "SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "link_still_live",
      sql: "SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: anchorLink,
};

function anchorLink(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { link_id: string; selector?: AnchorSelector };
  if (input.selector) {
    const anchorId = writeAnchor(ctx, input.link_id, input.selector);
    ctx.wrote("core.link_anchor", anchorId);
    return { link_id: input.link_id, anchor_id: anchorId };
  }
  const existing = ctx.db
    .prepare("SELECT anchor_id FROM core_link_anchor WHERE link_id = ?")
    .get(input.link_id) as { anchor_id: string } | undefined;
  if (existing) {
    ctx.db
      .prepare("DELETE FROM core_link_anchor WHERE anchor_id = ?")
      .run(existing.anchor_id);
    ctx.wrote("core.link_anchor", existing.anchor_id);
  }
  return { link_id: input.link_id };
}

export function registerLinkCommands(gateway: Gateway): void {
  gateway.registerCommand(LINK);
  gateway.registerCommand(UNLINK);
  gateway.registerCommand(ANCHOR);
}
