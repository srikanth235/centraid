// governance: allow-repo-hygiene file-size-limit the staging commands and the broker-credential lifecycle commands (#304) are one sync vocabulary — begin/finish/cursor/status and configure/store share the connection state machine, so splitting scatters the invariants
// Agent staging (#290): `sync.stage_rows` is low-risk; `sync.publish_batch` is
// high and parks. Credentials stay harness-ambient.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { PUBLISHERS } from "../ingest/publishers.js";
import {
  applyBatchTx,
  ensureConnectionTx,
  stageBatchTx,
} from "../ingest/staging.js";
import type { StageCandidate } from "../ingest/staging.js";
import { sealedColumnsOf } from "../schema/sealed.js";

/** Derived-data class per stageable entity (#310) — the unit auto-publish trust narrows. */
const ENRICH_CLASS_OF: Readonly<Record<string, string>> = {
  "knowledge.annotation": "caption",
  "core.tag": "tag",
  "media.face_region": "face",
  "core.collection": "collection",
  "core.content_item": "filing",
};

/** Bound one call's staging payload — bulk arrives as several batches. */
const MAX_ROWS_PER_STAGE = 500;

const STAGE_ROWS: CommandDefinition = {
  name: "sync.stage_rows",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["rows"],
    anyOf: [{ required: ["connection_id"] }, { required: ["kind", "label"] }],
    additionalProperties: false,
    properties: {
      // e.g. `pull.gmail` — names the SOURCE the agent read.
      kind: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      connection_id: { type: "string", minLength: 1 },
      rows: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ROWS_PER_STAGE,
        items: {
          type: "object",
          required: ["entity_type", "external_id", "payload"],
          additionalProperties: false,
          properties: {
            entity_type: { type: "string", minLength: 1 },
            external_id: { type: "string", minLength: 1 },
            payload: { type: "object" },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["batch_id", "connection_id"],
    properties: {
      batch_id: { type: "string" },
      connection_id: { type: "string" },
      staged: { type: "object" },
      published: { type: "object" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: "batch_staged_or_auto_published",
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status IN ('draft','published')`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: stageRows,
};

function stageRows(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind?: string;
    label?: string;
    connection_id?: string;
    rows: {
      entity_type: string;
      external_id: string;
      payload: Record<string, unknown>;
    }[];
  };
  // Refuse at STAGING, not at the publish click.
  for (const row of input.rows) {
    if (!PUBLISHERS.has(row.entity_type)) {
      throw new Error(
        `no publisher for "${row.entity_type}" — stageable: ${[...PUBLISHERS.keys()].join(", ")}`
      );
    }
    // Sealed types stage only through the owner's file-drop surface (#293).
    if (sealedColumnsOf(row.entity_type).length > 0) {
      throw new Error(
        `"${row.entity_type}" carries sealed columns — secret material stages only through the owner's import surface (issue #293)`
      );
    }
  }
  const connection = resolveConnectionIdentity(ctx, input);
  const connectionId = connection.connectionId;
  // Attribution injected server-side, never trusted from source (#299).
  const authorPartyId = ctx.identity.partyId ?? ownerPartyIdOf(ctx);
  const candidates: StageCandidate[] = input.rows.map((r) => ({
    entityType: r.entity_type,
    externalId: r.external_id,
    payload:
      r.entity_type === "knowledge.annotation"
        ? { ...r.payload, author_party_id: authorPartyId }
        : r.payload,
  }));
  // Standing consent (#299): `auto-publish` applies in-command, receipted.
  // Per-class narrowing (#310): outside classes stage as a separate draft,
  // never silently dropped or landed.
  const conn = ctx.db
    .prepare(
      "SELECT trust, enrich_classes_json FROM sync_connection WHERE connection_id = ?"
    )
    .get(connectionId) as
    | { trust: string; enrich_classes_json: string | null }
    | undefined;
  if (conn?.trust === "auto-publish") {
    const allowed = conn.enrich_classes_json
      ? new Set(JSON.parse(conn.enrich_classes_json) as string[])
      : null;
    const auto: StageCandidate[] = [];
    const held: StageCandidate[] = [];
    for (const c of candidates) {
      const cls = ENRICH_CLASS_OF[c.entityType];
      if (allowed === null || (cls !== undefined && allowed.has(cls)))
        auto.push(c);
      else held.push(c);
    }
    let heldBatchId: string | null = null;
    if (held.length > 0) {
      const heldStage = stageBatchTx(
        ctx.db,
        connectionId,
        held,
        PUBLISHERS,
        ctx.now
      );
      heldBatchId = heldStage.batchId;
      ctx.wrote("sync.import_batch", heldBatchId);
      ctx.cite({
        claim: `${held.length} row(s) in classes outside the connection's standing consent staged as draft ${heldBatchId} for review`,
        entityType: "sync.import_batch",
        entityId: heldBatchId,
      });
    }
    const { batchId, counts } = stageBatchTx(
      ctx.db,
      connectionId,
      auto,
      PUBLISHERS,
      ctx.now
    );
    ctx.wrote("sync.import_batch", batchId);
    const applied = applyBatchTx(
      ctx.db,
      batchId,
      PUBLISHERS,
      ownerPartyIdOf(ctx),
      ctx.now
    );
    for (const write of applied.provenanced) ctx.wrote(write.type, write.id);
    ctx.cite({
      claim: `auto-published ${applied.created + applied.updated} row(s) from ${connection.kind} "${connection.label}" under the connection's standing trust (${applied.failed.length} failed)`,
      entityType: "sync.import_batch",
      entityId: batchId,
    });
    return {
      batch_id: batchId,
      connection_id: connectionId,
      staged: counts,
      published: {
        created: applied.created,
        updated: applied.updated,
        skipped: applied.skipped,
        failed: applied.failed.length,
      },
      ...(heldBatchId ? { held_batch_id: heldBatchId, held: held.length } : {}),
    };
  }
  const { batchId, counts } = stageBatchTx(
    ctx.db,
    connectionId,
    candidates,
    PUBLISHERS,
    ctx.now
  );
  ctx.wrote("sync.import_batch", batchId);
  ctx.cite({
    claim: `staged ${input.rows.length} row(s) from ${connection.kind} "${connection.label}" as draft ${batchId} (${counts.create} create, ${counts.update} update, ${counts.skip} skip)`,
    entityType: "sync.import_batch",
    entityId: batchId,
  });
  return { batch_id: batchId, connection_id: connectionId, staged: counts };
}

function ownerPartyIdOf(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

const PUBLISH_BATCH: CommandDefinition = {
  name: "sync.publish_batch",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["batch_id"],
    additionalProperties: false,
    properties: { batch_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["batch_id", "created", "updated", "skipped"],
    properties: {
      batch_id: { type: "string" },
      created: { type: "integer" },
      updated: { type: "integer" },
      skipped: { type: "integer" },
      failed: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "batch_is_a_draft",
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status = 'draft'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "batch_published",
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status = 'published'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  // Agent-proposed publish PARKS for the owner (#306 Tier 4).
  risk: "high",
  confirm: true,
  handler: publishStagedBatch,
};

function publishStagedBatch(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { batch_id: string };
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  const applied = applyBatchTx(
    ctx.db,
    input.batch_id,
    PUBLISHERS,
    owner.owner_party_id,
    ctx.now
  );
  // Published rows ride the pipeline's evidence; data triggers may react.
  for (const write of applied.provenanced) ctx.wrote(write.type, write.id);
  ctx.wrote("sync.import_batch", input.batch_id);
  ctx.cite({
    claim: `published batch ${input.batch_id} from ${applied.kind}: ${applied.created} created, ${applied.updated} updated, ${applied.skipped} skipped, ${applied.failed.length} failed`,
    entityType: "sync.import_batch",
    entityId: input.batch_id,
  });
  return {
    batch_id: input.batch_id,
    created: applied.created,
    updated: applied.updated,
    skipped: applied.skipped,
    failed: applied.failed.length,
  };
}

// ── Connection lifecycle (#290 phase 4) ─────────────────────────────────
// `begin_run` is the principal-pinning hard gate; `finish_run` closes the run
// log and flips health; `set_cursor` persists position as receipted rows.
// Health is READABLE state — sync never dies silently.

const BEGIN_RUN: CommandDefinition = {
  name: "sync.begin_run",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    anyOf: [{ required: ["connection_id"] }, { required: ["kind", "label"] }],
    additionalProperties: false,
    properties: {
      kind: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      connection_id: { type: "string", minLength: 1 },
      /** The OBSERVED authenticated account (the connector's whoami probe). */
      principal: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id"],
    properties: {
      connection_id: { type: "string" },
      run_id: { type: "string" },
      cursors: { type: "object" },
      // A refusal is an OUTPUT — the needs-auth flip must survive it.
      refused: {
        type: "string",
        enum: ["paused", "principal-required", "principal-mismatch"],
      },
      reason: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: beginRun,
};

function resolveConnectionIdentity(
  ctx: HandlerCtx,
  input: { kind?: string; label?: string; connection_id?: string }
): { connectionId: string; kind: string; label: string } {
  if (!input.connection_id) {
    if (!input.kind || !input.label) {
      throw new Error("sync connection requires connection_id or kind + label");
    }
    return {
      connectionId: ensureConnectionTx(ctx.db, {
        kind: input.kind,
        label: input.label,
      }),
      kind: input.kind,
      label: input.label,
    };
  }
  const connection = ctx.db
    .prepare("SELECT kind, label FROM sync_connection WHERE connection_id = ?")
    .get(input.connection_id) as { kind: string; label: string } | undefined;
  if (!connection)
    throw new Error(`bound connection "${input.connection_id}" does not exist`);
  if (input.kind && connection.kind !== input.kind) {
    throw new Error(
      `bound connection "${input.connection_id}" has kind "${connection.kind}", expected "${input.kind}"`
    );
  }
  return {
    connectionId: input.connection_id,
    kind: connection.kind,
    label: connection.label,
  };
}

function beginRun(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind?: string;
    label?: string;
    connection_id?: string;
    principal?: string;
  };
  const identity = resolveConnectionIdentity(ctx, input);
  const connectionId = identity.connectionId;
  const connection = ctx.db
    .prepare(
      "SELECT principal, status FROM sync_connection WHERE connection_id = ?"
    )
    .get(connectionId) as { principal: string | null; status: string };

  // Paused means paused — absolute until the owner resumes.
  if (connection.status === "paused") {
    return {
      connection_id: connectionId,
      refused: "paused",
      reason: `connection "${identity.label}" is paused by the owner`,
    };
  }
  // Principal pinning: first principal pins; mismatches flip needs-auth. The
  // refusal is an output — the health flip must COMMIT.
  if (connection.principal === null && input.principal) {
    ctx.db
      .prepare(
        "UPDATE sync_connection SET principal = ? WHERE connection_id = ?"
      )
      .run(input.principal, connectionId);
  } else if (connection.principal !== null) {
    if (!input.principal) {
      ctx.db
        .prepare(
          `UPDATE sync_connection SET status = 'needs-auth' WHERE connection_id = ?`
        )
        .run(connectionId);
      setAuthNote(
        ctx,
        connectionId,
        `reconnect ${identity.label}: the provider did not report the pinned principal`,
        { preserveUpdatedAt: connection.status === "needs-auth" }
      );
      ctx.wrote("sync.connection", connectionId);
      return {
        connection_id: connectionId,
        refused: "principal-required",
        reason: `connection "${identity.label}" pins principal "${connection.principal}" — begin_run must carry the observed principal`,
      };
    }
    if (input.principal !== connection.principal) {
      ctx.db
        .prepare(
          `UPDATE sync_connection SET status = 'needs-auth' WHERE connection_id = ?`
        )
        .run(connectionId);
      setAuthNote(
        ctx,
        connectionId,
        `reconnect ${identity.label}: authenticated principal does not match the pinned account`,
        { preserveUpdatedAt: connection.status === "needs-auth" }
      );
      ctx.wrote("sync.connection", connectionId);
      return {
        connection_id: connectionId,
        refused: "principal-mismatch",
        reason: `connection "${identity.label}" pins "${connection.principal}" but the harness is authenticated as "${input.principal}"`,
      };
    }
  }
  // A matching (or first) principal proves reach — back to active.
  ctx.db
    .prepare(
      `UPDATE sync_connection SET status = 'active' WHERE connection_id = ?`
    )
    .run(connectionId);
  setAuthNote(ctx, connectionId, null);
  const runId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO sync_connection_run (run_id, connection_id, started_at, finished_at, status, staged, published, skipped, error)
       VALUES (?, ?, ?, NULL, 'running', 0, 0, 0, NULL)`
    )
    .run(runId, connectionId, ctx.now);
  ctx.wrote("sync.connection", connectionId);
  ctx.wrote("sync.connection_run", runId);
  const cursors = Object.fromEntries(
    (
      ctx.db
        .prepare(
          "SELECT key, value_json FROM sync_connection_cursor WHERE connection_id = ?"
        )
        .all(connectionId) as { key: string; value_json: string }[]
    ).map((r) => [r.key, JSON.parse(r.value_json) as unknown])
  );
  return { connection_id: connectionId, run_id: runId, cursors };
}

const FINISH_RUN: CommandDefinition = {
  name: "sync.finish_run",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["run_id", "ok"],
    additionalProperties: false,
    properties: {
      run_id: { type: "string", minLength: 1 },
      ok: { type: "boolean" },
      staged: { type: "integer", minimum: 0 },
      published: { type: "integer", minimum: 0 },
      skipped: { type: "integer", minimum: 0 },
      error: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["run_id"],
    properties: {
      run_id: { type: "string" },
      connection_status: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "run_is_open",
      sql: `SELECT count(*) AS n FROM sync_connection_run WHERE run_id = :run_id AND status = 'running'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "run_closed",
      sql: `SELECT count(*) AS n FROM sync_connection_run WHERE run_id = :run_id AND status != 'running'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: finishRun,
};

function finishRun(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    run_id: string;
    ok: boolean;
    staged?: number;
    published?: number;
    skipped?: number;
    error?: string;
  };
  const run = ctx.db
    .prepare("SELECT connection_id FROM sync_connection_run WHERE run_id = ?")
    .get(input.run_id) as { connection_id: string };
  ctx.db
    .prepare(
      `UPDATE sync_connection_run SET finished_at = ?, status = ?, staged = ?, published = ?, skipped = ?, error = ? WHERE run_id = ?`
    )
    .run(
      ctx.now,
      input.ok ? "ok" : "failed",
      input.staged ?? 0,
      input.published ?? 0,
      input.skipped ?? 0,
      input.error ?? null,
      input.run_id
    );
  // Failed run → failing (visible, never silent); needs-auth stays sticky.
  const status = input.ok ? "active" : "failing";
  ctx.db
    .prepare(
      `UPDATE sync_connection SET last_run_at = ?, status = CASE WHEN status = 'needs-auth' THEN status ELSE ? END
        WHERE connection_id = ?`
    )
    .run(ctx.now, status, run.connection_id);
  ctx.wrote("sync.connection_run", input.run_id);
  ctx.wrote("sync.connection", run.connection_id);
  ctx.cite({
    claim: `run ${input.run_id} finished ${input.ok ? "ok" : `failed: ${input.error ?? "unknown"}`} (staged ${input.staged ?? 0}, published ${input.published ?? 0}, skipped ${input.skipped ?? 0})`,
    entityType: "sync.connection_run",
    entityId: input.run_id,
  });
  return {
    run_id: input.run_id,
    connection_status: input.ok ? "active" : status,
  };
}

const SET_CURSOR: CommandDefinition = {
  name: "sync.set_cursor",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["connection_id", "key", "value"],
    additionalProperties: false,
    properties: {
      connection_id: { type: "string", minLength: 1 },
      key: { type: "string", minLength: 1 },
      value: {},
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id", "key"],
    properties: { connection_id: { type: "string" }, key: { type: "string" } },
  },
  preconditions: [
    {
      name: "connection_exists",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: setCursor,
};

function setCursor(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    connection_id: string;
    key: string;
    value: unknown;
  };
  const existing = ctx.db
    .prepare(
      "SELECT cursor_id FROM sync_connection_cursor WHERE connection_id = ? AND key = ?"
    )
    .get(input.connection_id, input.key) as { cursor_id: string } | undefined;
  const cursorId = existing?.cursor_id ?? ctx.newId();
  if (existing) {
    ctx.db
      .prepare(
        "UPDATE sync_connection_cursor SET value_json = ?, updated_at = ? WHERE cursor_id = ?"
      )
      .run(JSON.stringify(input.value ?? null), ctx.now, cursorId);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO sync_connection_cursor (cursor_id, connection_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        cursorId,
        input.connection_id,
        input.key,
        JSON.stringify(input.value ?? null),
        ctx.now
      );
  }
  ctx.wrote("sync.connection_cursor", cursorId);
  return { connection_id: input.connection_id, key: input.key };
}

const SET_CONNECTION_STATUS: CommandDefinition = {
  name: "sync.set_connection_status",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["connection_id", "status"],
    additionalProperties: false,
    properties: {
      connection_id: { type: "string", minLength: 1 },
      // Owner's two levers; `needs-auth` is also the fire path's flip (#293).
      status: { type: "string", enum: ["paused", "active", "needs-auth"] },
      // WHY the connection left active (#304) — shown to the owner.
      note: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id", "status"],
    properties: {
      connection_id: { type: "string" },
      status: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "connection_exists",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "status_applied",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id AND status = :status`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  // NOT confirm-gated (#308 A2): the fire path's needs-auth flip must land
  // unparked; no status value moves credentials or hosts.
  risk: "medium",
  handler: setConnectionStatus,
};

function setConnectionStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    connection_id: string;
    status: string;
    note?: string;
  };
  const previous = ctx.db
    .prepare("SELECT status FROM sync_connection WHERE connection_id = ?")
    .get(input.connection_id) as { status: string };
  ctx.db
    .prepare("UPDATE sync_connection SET status = ? WHERE connection_id = ?")
    .run(input.status, input.connection_id);
  // `active` clears any stale complaint; flips record why via note.
  if (input.status === "active") {
    setAuthNote(ctx, input.connection_id, null);
  } else if (input.note !== undefined) {
    setAuthNote(ctx, input.connection_id, input.note, {
      preserveUpdatedAt:
        previous.status === "needs-auth" && input.status === "needs-auth",
    });
  }
  ctx.wrote("sync.connection", input.connection_id);
  return { connection_id: input.connection_id, status: input.status };
}

// ── Broker-owned credentials (#304) ─────────────────────────────────────
// A connection may carry `oauth2` (BYO) or `api_key` instead of harness-
// ambient auth. Secret cells are sealed columns whose ONLY consumer is the
// broker, injected into `ctx.fetch` toward `allowed_hosts`, never handed to
// connector code. Both commands CONFIRM-GATED (#308 A1/A2): they touch what
// must never move on a model's say-so. Owner-plane paths never park.

const CONFIGURE_CREDENTIAL: CommandDefinition = {
  name: "sync.configure_credential",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["kind", "label", "cred_kind"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      // `none` DETACHES: cells null out, back to harness-ambient.
      cred_kind: { type: "string", enum: ["oauth2", "api_key", "none"] },
      // `assist` uses Centraid's confidential Worker client; no client secret
      // accepted or stored.
      oauth_mode: { type: "string", enum: ["byo", "assist"] },
      // Which BYO-client walkthrough applies. Free-form.
      provider: { type: "string", minLength: 1 },
      auth_url: { type: "string", minLength: 1 },
      token_url: { type: "string", minLength: 1 },
      scopes: { type: "string", minLength: 1 },
      client_id: { type: "string", minLength: 1 },
      client_secret: { type: "string", minLength: 1 },
      api_key: { type: "string", minLength: 1 },
      allowed_hosts: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id", "cred_kind", "status"],
    properties: {
      connection_id: { type: "string" },
      cred_kind: { type: "string" },
      status: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [],
  sealedInput: ["client_secret", "api_key"],
  idempotency: "idempotent",
  // `allowed_hosts` IS the #304 anti-exfiltration pin; non-owner proposals
  // park (#308 A1 — `confirm`, not risk, parks post-#306).
  risk: "medium",
  confirm: true,
  handler: configureCredential,
};

function configureCredential(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind: string;
    label: string;
    cred_kind: "oauth2" | "api_key" | "none";
    oauth_mode?: "byo" | "assist";
    provider?: string;
    auth_url?: string;
    token_url?: string;
    scopes?: string;
    client_id?: string;
    client_secret?: string;
    api_key?: string;
    allowed_hosts?: string[];
  };
  const connectionId = ensureConnectionTx(ctx.db, {
    kind: input.kind,
    label: input.label,
  });
  if (input.cred_kind === "none") {
    // Detach = DELETE the sidecar row; no half-shredded credentials.
    ctx.db
      .prepare("DELETE FROM sync_connection_credential WHERE connection_id = ?")
      .run(connectionId);
    ctx.db
      .prepare("DELETE FROM sync_connection_health WHERE connection_id = ?")
      .run(connectionId);
    ctx.wrote("sync.connection", connectionId);
    ctx.cite({
      claim: `detached the credential from ${input.kind} "${input.label}" — back on the harness-ambient lane`,
      entityType: "sync.connection",
      entityId: connectionId,
    });
    return { connection_id: connectionId, cred_kind: "none", status: "active" };
  }
  // The host pin is the anti-exfiltration invariant (#304 decision 2): both
  // kinds refuse to configure without one.
  if (!input.allowed_hosts || input.allowed_hosts.length === 0) {
    throw new Error(
      `cred_kind "${input.cred_kind}" requires allowed_hosts — the hosts this credential may be injected toward (issue #304)`
    );
  }
  if (input.cred_kind === "oauth2") {
    if (!input.auth_url || !input.token_url || !input.client_id) {
      throw new Error(
        'cred_kind "oauth2" requires auth_url, token_url and client_id (the owner-registered BYO client, issue #304)'
      );
    }
    if (input.oauth_mode === "assist" && input.client_secret) {
      throw new Error(
        "Centraid Assist must not send or store a Google client secret"
      );
    }
  } else if (input.oauth_mode !== undefined) {
    throw new Error("oauth_mode is valid only for oauth2 credentials");
  } else if (!input.api_key) {
    throw new Error('cred_kind "api_key" requires api_key');
  }
  // Switching kinds must never leak the previous credential's cells: replace
  // the whole row, unset optionals NULL. oauth2 starts needs-auth; api_key is
  // complete.
  const status = input.cred_kind === "oauth2" ? "needs-auth" : "active";
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO sync_connection_credential
         (connection_id, cred_kind, oauth_mode, provider, auth_url, token_url, scopes,
          client_id, client_secret, access_token, refresh_token, api_key,
          token_expires_at, allowed_hosts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`
    )
    .run(
      connectionId,
      input.cred_kind,
      input.cred_kind === "oauth2" ? (input.oauth_mode ?? "byo") : "byo",
      input.provider ?? null,
      input.auth_url ?? null,
      input.token_url ?? null,
      input.scopes ?? null,
      input.client_id ?? null,
      input.client_secret ?? null,
      input.api_key ?? null,
      JSON.stringify(input.allowed_hosts),
      ctx.now
    );
  ctx.db
    .prepare("UPDATE sync_connection SET status = ? WHERE connection_id = ?")
    .run(status, connectionId);
  setAuthNote(
    ctx,
    connectionId,
    input.cred_kind === "oauth2" ? "authorization pending — run Connect" : null
  );
  ctx.wrote("sync.connection", connectionId);
  ctx.wrote("sync.connection_credential", connectionId);
  ctx.cite({
    claim: `configured a ${input.cred_kind} credential on ${input.kind} "${input.label}" pinned to ${input.allowed_hosts.join(", ")}`,
    entityType: "sync.connection",
    entityId: connectionId,
  });
  return { connection_id: connectionId, cred_kind: input.cred_kind, status };
}

/** Upsert (or clear) the connection's owner-readable health note. */
function setAuthNote(
  ctx: HandlerCtx,
  connectionId: string,
  note: string | null,
  options: { preserveUpdatedAt?: boolean } = {}
): void {
  if (note === null) {
    ctx.db
      .prepare("DELETE FROM sync_connection_health WHERE connection_id = ?")
      .run(connectionId);
    return;
  }
  if (options.preserveUpdatedAt) {
    const updated = ctx.db
      .prepare(
        "UPDATE sync_connection_health SET auth_note = ? WHERE connection_id = ?"
      )
      .run(note, connectionId);
    if (Number(updated.changes) > 0) return;
  }
  ctx.db
    .prepare(
      `INSERT INTO sync_connection_health (connection_id, auth_note, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET auth_note = excluded.auth_note, updated_at = excluded.updated_at`
    )
    .run(connectionId, note, ctx.now);
}

const STORE_TOKENS: CommandDefinition = {
  name: "sync.store_tokens",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["connection_id", "access_token"],
    additionalProperties: false,
    properties: {
      connection_id: { type: "string", minLength: 1 },
      access_token: { type: "string", minLength: 1 },
      // Absent when refresh does not rotate; rotating providers MUST land
      // the new one in the same act.
      refresh_token: { type: "string", minLength: 1 },
      // Issue #865: the Worker-minted HMAC capability authenticating the
      // refresh token at /refresh. Absent when no (new) refresh token is
      // present; MUST land in the same act as a new refresh token.
      refresh_capability: { type: "string", minLength: 1 },
      expires_at: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id", "status"],
    properties: {
      connection_id: { type: "string" },
      status: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "connection_is_oauth2",
      sql: `SELECT count(*) AS n FROM sync_connection_credential WHERE connection_id = :connection_id AND cred_kind = 'oauth2'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  sealedInput: ["access_token", "refresh_token", "refresh_capability"],
  idempotency: "idempotent",
  // Confirm-gated (#308): swapping the token pair re-principals every drain.
  risk: "low",
  confirm: true,
  handler: storeTokens,
};

function storeTokens(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    connection_id: string;
    access_token: string;
    refresh_token?: string;
    refresh_capability?: string;
    expires_at?: string;
  };
  ctx.db
    .prepare(
      `UPDATE sync_connection_credential SET access_token = ?,
         refresh_token = COALESCE(?, refresh_token),
         refresh_capability = COALESCE(?, refresh_capability),
         token_expires_at = ?, updated_at = ?
       WHERE connection_id = ?`
    )
    .run(
      input.access_token,
      input.refresh_token ?? null,
      input.refresh_capability ?? null,
      input.expires_at ?? null,
      ctx.now,
      input.connection_id
    );
  ctx.db
    .prepare(
      `UPDATE sync_connection SET status = 'active' WHERE connection_id = ?`
    )
    .run(input.connection_id);
  setAuthNote(ctx, input.connection_id, null);
  ctx.wrote("sync.connection", input.connection_id);
  ctx.wrote("sync.connection_credential", input.connection_id);
  ctx.cite({
    claim: `landed a fresh token pair on connection ${input.connection_id}${input.expires_at ? ` (expires ${input.expires_at})` : ""}`,
    entityType: "sync.connection",
    entityId: input.connection_id,
  });
  return { connection_id: input.connection_id, status: "active" };
}

// ── Removal (#304) ──────────────────────────────────────────────────────
// `sync.remove_connection` is the owner's actual DELETE, vs
// `configure_credential({cred_kind:'none'})`'s detach. Irreversible:
// Tier 4 (risk high, confirm-gated), like `core.merge_party`.
//
// What may be deleted and what BLOCKS is discovered LIVE off the schema
// (`PRAGMA foreign_key_list`), so no hand-kept table list can rot:
//   - #304 sidecars: ON DELETE CASCADE; deleted explicitly anyway so the
//     receipt's write list stays complete.
//   - `sync_connection_cursor`: pure position, no audit value — deleted.
//   - nullable service anchors (#310): cleared, never a block.
//   - receipted history (`outbox_item`, `sync_import_batch`,
//     `sync_external_entity`, `sync_connection_run`): ANY row BLOCKS —
//     cleanup must never shred the audit trail.

interface ConnectionFkRef {
  table: string;
  column: string;
  notNull: boolean;
}

/**
 * Every live FK column referencing `sync_connection(connection_id)`, minus
 * SQLite-cascaded sidecars.
 */
function connectionFkRefs(ctx: HandlerCtx): ConnectionFkRef[] {
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'sync_connection'`
    )
    .all() as { name: string }[];
  const refs: ConnectionFkRef[] = [];
  for (const { name } of tables) {
    const fks = ctx.db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all() as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    for (const fk of fks) {
      if (fk.table !== "sync_connection") continue;
      if (fk.on_delete === "CASCADE") continue;
      const col = (
        ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
          name: string;
          notnull: number;
        }[]
      ).find((c) => c.name === fk.from);
      refs.push({ table: name, column: fk.from, notNull: col?.notnull === 1 });
    }
  }
  return refs;
}

const REMOVE_CONNECTION: CommandDefinition = {
  name: "sync.remove_connection",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["connection_id"],
    additionalProperties: false,
    properties: { connection_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id"],
    properties: { connection_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "connection_exists",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "connection_gone",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  // Tier 4 (#306): irreversible, so it stays loud — the core.merge_party stance.
  risk: "high",
  confirm: true,
  handler: removeConnection,
};

function removeConnection(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { connection_id: string };
  const connectionId = input.connection_id;
  const connection = ctx.db
    .prepare("SELECT kind, label FROM sync_connection WHERE connection_id = ?")
    .get(connectionId) as { kind: string; label: string };
  const name = `${connection.kind} "${connection.label}"`;

  // Undecided outbox items get first say: name the lever that clears it.
  const undecided = ctx.db
    .prepare(
      `SELECT count(*) AS n FROM outbox_item WHERE connection_id = ? AND status IN ('pending','approved')`
    )
    .get(connectionId) as { n: number };
  if (undecided.n > 0) {
    throw new Error(
      `${name} has ${undecided.n} outbox item(s) still awaiting a decision — approve, discard, or let them drain before removing this connection`
    );
  }

  const refs = connectionFkRefs(ctx).filter(
    (r) => r.table !== "sync_connection_cursor"
  );
  const historyBlocks: string[] = [];
  for (const ref of refs) {
    if (!ref.notNull) continue; // nullable anchors are cleared below, never a block
    const row = ctx.db
      .prepare(
        `SELECT count(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`
      )
      .get(connectionId) as { n: number };
    if (row.n > 0) historyBlocks.push(`${row.n} ${ref.table} row(s)`);
  }
  if (historyBlocks.length > 0) {
    throw new Error(
      `${name} has sync history that removal would erase (${historyBlocks.join(", ")}) — receipted history is never deleted; pause the connection, or detach its credential, instead of removing it`
    );
  }

  // Nullable service anchors are metadata, not audit — cleared, never a block.
  for (const ref of refs) {
    if (ref.notNull) continue;
    ctx.db
      .prepare(
        `UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" = ?`
      )
      .run(connectionId);
  }

  ctx.db
    .prepare("DELETE FROM sync_connection_cursor WHERE connection_id = ?")
    .run(connectionId);
  // Deleted explicitly though cascaded, so the write list stays honest.
  ctx.db
    .prepare("DELETE FROM sync_connection_credential WHERE connection_id = ?")
    .run(connectionId);
  ctx.db
    .prepare("DELETE FROM sync_connection_health WHERE connection_id = ?")
    .run(connectionId);
  ctx.db
    .prepare("DELETE FROM sync_connection WHERE connection_id = ?")
    .run(connectionId);
  ctx.wrote("sync.connection", connectionId);
  ctx.cite({
    claim: `removed connection ${name} — no undecided outbox items or sync history existed to protect`,
    entityType: "sync.connection",
    entityId: connectionId,
  });
  return { connection_id: connectionId };
}

export function registerSyncCommands(gateway: Gateway): void {
  gateway.registerCommand(STAGE_ROWS);
  gateway.registerCommand(PUBLISH_BATCH);
  gateway.registerCommand(BEGIN_RUN);
  gateway.registerCommand(FINISH_RUN);
  gateway.registerCommand(SET_CURSOR);
  gateway.registerCommand(SET_CONNECTION_STATUS);
  gateway.registerCommand(CONFIGURE_CREDENTIAL);
  gateway.registerCommand(STORE_TOKENS);
  gateway.registerCommand(REMOVE_CONNECTION);
}
