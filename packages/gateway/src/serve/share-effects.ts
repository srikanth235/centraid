import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import type { GatewayDatabase } from "./gateway-db.js";

export type ShareEffectState =
  | "queued"
  | "running"
  | "parked"
  | "executed"
  | "denied"
  | "failed"
  | "cancelled"
  | "expired";

interface AwaitGiveDecisionPayload {
  linkId: string;
  itemType: string;
  itemCount: number;
}

interface PullBlobPayload {
  linkId: string;
  sha256: string;
  size: number;
  tmpPath: string;
}

interface NotifyRefusalPayload {
  linkId: string;
}

export interface DeliverCommonsInvitationPayload {
  linkId: string;
  grantId: string;
  invitationId: string;
  stewardVaultId: string;
  memberVaultId: string;
  memberPartyId: string;
  capability: "read" | "read+write";
  containerType: string;
  containerId: string;
  containerLabel?: string;
  currentSizeBytes: number;
  maxSizeBytes?: number;
}

export type ShareEffect =
  | ShareEffectBase<"await-give-decision", AwaitGiveDecisionPayload>
  | ShareEffectBase<"pull-blob", PullBlobPayload>
  | ShareEffectBase<"notify-refusal", NotifyRefusalPayload>
  | ShareEffectBase<
      "deliver-commons-invitation",
      DeliverCommonsInvitationPayload
    >;

interface ShareEffectBase<K extends string, P> {
  effectId: string;
  edgeId: string;
  kind: K;
  state: ShareEffectState;
  localVaultId: string;
  peerVaultId: string;
  payload: P;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  updatedAt: string;
}

interface ShareEffectRow {
  effect_id: string;
  edge_id: string;
  kind: ShareEffect["kind"];
  state: ShareEffectState;
  local_vault_id: string;
  peer_vault_id: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: number;
  created_at: string;
  updated_at: string;
}

const LEGAL_TRANSITIONS: Readonly<
  Record<ShareEffectState, ReadonlySet<ShareEffectState>>
> = {
  queued: new Set([
    "running",
    "parked",
    "executed",
    "denied",
    "failed",
    "cancelled",
    "expired",
  ]),
  running: new Set([
    "parked",
    "executed",
    "denied",
    "failed",
    "cancelled",
    "expired",
  ]),
  parked: new Set([
    "running",
    "executed",
    "denied",
    "failed",
    "cancelled",
    "expired",
  ]),
  executed: new Set(),
  denied: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

/** One typed durable effect substrate for local and peer sharing workflows. */
export class ShareEffectsStore {
  constructor(private readonly database: GatewayDatabase) {}

  enqueue(input: {
    effectId?: string;
    edgeId: string;
    kind: ShareEffect["kind"];
    localVaultId: string;
    peerVaultId: string;
    payload: Record<string, unknown>;
    now?: () => number;
  }): ShareEffect {
    parsePayload(input.kind, input.payload);
    const payloadJson = JSON.stringify(input.payload);
    const nowMs = (input.now ?? Date.now)();
    const now = new Date(nowMs).toISOString();
    this.database.run(
      `INSERT INTO share_effects (
         effect_id, edge_id, kind, state, local_vault_id, peer_vault_id,
         payload_json, attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT (edge_id, kind, payload_json) DO NOTHING`,
      input.effectId ?? randomUUID(),
      input.edgeId,
      input.kind,
      input.localVaultId,
      input.peerVaultId,
      payloadJson,
      now,
      now
    );
    const effect = this.byIdentity(input.edgeId, input.kind, payloadJson);
    if (!effect) throw new Error("share effect could not be enqueued");
    return effect;
  }

  get(effectId: string): ShareEffect | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM share_effects WHERE effect_id = ?")
      .get(effectId) as ShareEffectRow | undefined;
    return row ? toEffect(row) : undefined;
  }

  list(
    input: {
      kind?: ShareEffect["kind"];
      edgeId?: string;
      active?: boolean;
      dueAt?: number;
      limit?: number;
    } = {}
  ): ShareEffect[] {
    const predicates: string[] = [];
    const values: Array<string | number> = [];
    if (input.kind) {
      predicates.push("kind = ?");
      values.push(input.kind);
    }
    if (input.edgeId) {
      predicates.push("edge_id = ?");
      values.push(input.edgeId);
    }
    if (input.active) {
      predicates.push("state IN ('queued', 'running', 'parked')");
    }
    if (input.dueAt !== undefined) {
      predicates.push("next_attempt_at <= ?");
      values.push(input.dueAt);
    }
    const where =
      predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    if (input.limit !== undefined) values.push(input.limit);
    const rows = this.database.db
      .prepare(
        `SELECT * FROM share_effects ${where}
          ORDER BY created_at, effect_id${
            input.limit === undefined ? "" : " LIMIT ?"
          }`
      )
      .all(...values) as unknown as ShareEffectRow[];
    return rows.map(toEffect);
  }

  transition(
    effectId: string,
    state: ShareEffectState,
    input: { retryAt?: number; attempted?: boolean; now?: () => number } = {}
  ): ShareEffect | undefined {
    const effect = this.get(effectId);
    if (!effect) return effect;
    if (
      effect.state === state &&
      input.retryAt === undefined &&
      input.attempted !== true
    )
      return effect;
    if (effect.state !== state && !LEGAL_TRANSITIONS[effect.state].has(state)) {
      throw new Error(
        `illegal share effect transition ${effect.state} -> ${state}`
      );
    }
    const now = new Date((input.now ?? Date.now)()).toISOString();
    this.database.run(
      `UPDATE share_effects
          SET state = ?, attempts = attempts + ?, next_attempt_at = ?, updated_at = ?
        WHERE effect_id = ?`,
      state,
      input.attempted ? 1 : 0,
      input.retryAt ?? 0,
      now,
      effectId
    );
    return this.get(effectId);
  }

  /** Cancel an edge and release any resumable temp files it still owns. */
  cancelEdge(edgeId: string): void {
    for (const effect of this.list({ edgeId, active: true })) {
      if (effect.kind === "pull-blob") {
        rmSync(effect.payload.tmpPath, { force: true });
      }
      this.transition(effect.effectId, "cancelled");
    }
  }

  /** Bounded terminal history; active work is never pruned. */
  prune(input: { olderThan: number; keepNewest?: number }): number {
    const keepNewest = input.keepNewest ?? 10_000;
    const result = this.database.db
      .prepare(
        `DELETE FROM share_effects
          WHERE state IN ('executed', 'denied', 'failed', 'cancelled', 'expired')
            AND updated_at < ?
            AND effect_id NOT IN (
              SELECT effect_id FROM share_effects
               WHERE state IN ('executed', 'denied', 'failed', 'cancelled', 'expired')
               ORDER BY updated_at DESC LIMIT ?
            )`
      )
      .run(new Date(input.olderThan).toISOString(), keepNewest);
    return Number(result.changes);
  }

  private byIdentity(
    edgeId: string,
    kind: ShareEffect["kind"],
    payloadJson: string
  ): ShareEffect | undefined {
    const row = this.database.db
      .prepare(
        `SELECT * FROM share_effects
          WHERE edge_id = ? AND kind = ? AND payload_json = ?`
      )
      .get(edgeId, kind, payloadJson) as ShareEffectRow | undefined;
    return row ? toEffect(row) : undefined;
  }
}

function toEffect(row: ShareEffectRow): ShareEffect {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    effectId: row.effect_id,
    edgeId: row.edge_id,
    kind: row.kind,
    state: row.state,
    localVaultId: row.local_vault_id,
    peerVaultId: row.peer_vault_id,
    payload: parsePayload(row.kind, payload),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ShareEffect;
}

function parsePayload(
  kind: ShareEffect["kind"],
  value: Record<string, unknown>
): ShareEffect["payload"] {
  const string = (key: string): string => {
    const item = value[key];
    if (typeof item !== "string" || item.length === 0)
      throw new Error(`${kind} effect ${key} must be a non-empty string`);
    return item;
  };
  if (kind === "await-give-decision") {
    const itemCount = value.itemCount;
    if (!Number.isSafeInteger(itemCount) || (itemCount as number) < 0)
      throw new Error(
        "await-give-decision effect itemCount must be an integer"
      );
    return {
      linkId: string("linkId"),
      itemType: string("itemType"),
      itemCount: itemCount as number,
    };
  }
  if (kind === "pull-blob") {
    const size = value.size;
    if (!Number.isSafeInteger(size) || (size as number) < 0)
      throw new Error("pull-blob effect size must be an integer");
    return {
      linkId: string("linkId"),
      sha256: string("sha256"),
      size: size as number,
      tmpPath: string("tmpPath"),
    };
  }
  if (kind === "notify-refusal") return { linkId: string("linkId") };
  const capability = value.capability;
  if (capability !== "read" && capability !== "read+write")
    throw new Error(
      "deliver-commons-invitation effect capability must be read or read+write"
    );
  const currentSizeBytes = value.currentSizeBytes;
  if (
    !Number.isSafeInteger(currentSizeBytes) ||
    (currentSizeBytes as number) < 0
  )
    throw new Error(
      "deliver-commons-invitation effect currentSizeBytes must be an integer"
    );
  const maxSizeBytes = value.maxSizeBytes;
  if (
    maxSizeBytes !== undefined &&
    (!Number.isSafeInteger(maxSizeBytes) || (maxSizeBytes as number) < 0)
  )
    throw new Error(
      "deliver-commons-invitation effect maxSizeBytes must be an integer"
    );
  const containerLabel = value.containerLabel;
  if (containerLabel !== undefined && typeof containerLabel !== "string")
    throw new Error(
      "deliver-commons-invitation effect containerLabel must be a string"
    );
  return {
    linkId: string("linkId"),
    grantId: string("grantId"),
    invitationId: string("invitationId"),
    stewardVaultId: string("stewardVaultId"),
    memberVaultId: string("memberVaultId"),
    memberPartyId: string("memberPartyId"),
    capability,
    containerType: string("containerType"),
    containerId: string("containerId"),
    ...(containerLabel === undefined ? {} : { containerLabel }),
    currentSizeBytes: currentSizeBytes as number,
    ...(maxSizeBytes === undefined
      ? {}
      : { maxSizeBytes: maxSizeBytes as number }),
  };
}
