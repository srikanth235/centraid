import { createHash } from "node:crypto";

import type { VaultBridge } from "@centraid/server/engine";

import type { ConditionTrigger, DataTrigger } from "../manifest/manifest.js";
import { parseRef } from "../manifest/ref.js";
import type { CursorReadResult } from "./cursor-engine.js";

const MAX_SEEN_HASHES = 2000;

function rowHash(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, row[k]]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface ReadConditionCursorOptions {
  automationRef: string;
  trigger: ConditionTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function stringArrayPosition(positionJson: string | undefined): string[] {
  if (!positionJson) return [];
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export async function readConditionCursor(
  options: ReadConditionCursorOptions
): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const result = await options.vault({
    op: "read",
    payload: {
      entity: options.trigger.entity,
      ...(options.trigger.where ? { where: options.trigger.where } : {}),
      purpose: options.purpose,
      limit: 1000,
    },
  });
  if (!result.ok) {
    throw new Error(
      `${result.code ?? "VAULT_ERROR"}: ${result.error ?? "vault read failed"}`
    );
  }
  const rows = (
    (result.result as { rows?: Record<string, unknown>[] })?.rows ?? []
  ).slice();
  const seen = new Set(stringArrayPosition(options.positionJson));
  const current = rows.map(rowHash);
  const fresh = rows
    .map((row, index) => ({ row, hash: current[index]! }))
    .filter(({ hash }) => !seen.has(hash));
  const delivered = fresh.slice(0, options.limit);
  const deliveredHashes = new Set(delivered.map(({ hash }) => hash));
  const position = current.filter(
    (hash) => seen.has(hash) || deliveredHashes.has(hash)
  );
  const occurredAt = options.now.getTime();
  return {
    elements: delivered.map(({ row, hash }) => ({
      position: `${hash}:${occurredAt}`,
      occurredAt,
      payload: row,
    })),
    positionJson: JSON.stringify(position.slice(0, MAX_SEEN_HASHES)),
    skipped: 0,
  };
}

export interface ReadDataCursorOptions {
  automationRef: string;
  trigger: DataTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function scalarPosition(positionJson: string | undefined): string | null {
  if (!positionJson) return null;
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function changeId(change: Record<string, unknown>): string | undefined {
  for (const key of ["id", "provId", "provenanceId", "cursor"]) {
    const value = change[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function changePosition(
  change: Record<string, unknown>,
  index: number
): string {
  return changeId(change) ?? `${rowHash(change)}:${index}`;
}

export async function readDataCursor(
  options: ReadDataCursorOptions
): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const cursor = scalarPosition(options.positionJson);
  const result = await options.vault({
    op: "changes",
    payload: {
      entities: [...options.trigger.entities],
      purpose: options.purpose,
      cursor,
      limit: options.limit,
    },
  });
  if (!result.ok) {
    throw new Error(
      `${result.code ?? "VAULT_ERROR"}: ${result.error ?? "vault changes failed"}`
    );
  }
  const feed = result.result as {
    changes?: Record<string, unknown>[];
    cursor?: string;
  };
  const changes = feed.changes ?? [];
  const visible = cursor === null ? [] : changes;
  return {
    elements: visible.map((change, index) => {
      const watermark = changeId(change);
      return {
        position: changePosition(change, index),
        occurredAt: options.now.getTime(),
        payload: change,
        ...(watermark === undefined
          ? {}
          : { positionJson: JSON.stringify(watermark) }),
      };
    }),
    ...(typeof feed.cursor === "string"
      ? { positionJson: JSON.stringify(feed.cursor) }
      : {}),
    skipped: 0,
  };
}
