import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface MemoryProjectionDraft {
  memoryId: string;
  kind: "on-this-day" | "trip" | "similar";
  titleHint: string | null;
  dayKey: string | null;
  placeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  members: readonly string[];
}

export interface MemoryProjectionResult {
  onThisDay: number;
  trips: number;
  similar: number;
  /** Total `media_memory_member` rows in the resulting projection. */
  members: number;
  /** Whether the persisted projection matched and no rows were written. */
  reused: boolean;
}

interface ProjectionRow {
  memory_id: string;
  kind: string;
  title_hint: string | null;
  day_key: string | null;
  place_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  asset_id: string | null;
  ordinal: number | null;
}

type Counts = Omit<MemoryProjectionResult, "reused">;
const lastPassByVault = new WeakMap<
  DatabaseSync,
  { fingerprint: string; counts: Counts }
>();

function fingerprintOf(source: unknown, projection: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([source, projection]))
    .digest("hex");
}

function rowsOf(drafts: readonly MemoryProjectionDraft[]): ProjectionRow[] {
  const rows = drafts.flatMap((draft) =>
    draft.members.map((assetId, ordinal) => ({
      memory_id: draft.memoryId,
      kind: draft.kind,
      title_hint: draft.titleHint,
      day_key: draft.dayKey,
      place_id: draft.placeId,
      started_at: draft.startedAt,
      ended_at: draft.endedAt,
      asset_id: assetId,
      ordinal,
    }))
  );
  return rows.sort((a, b) =>
    a.memory_id === b.memory_id
      ? a.ordinal - b.ordinal
      : a.memory_id < b.memory_id
        ? -1
        : 1
  );
}

export function beginMemoryProjectionPass(
  vault: DatabaseSync,
  source: unknown
): {
  reused: MemoryProjectionResult | null;
  finish: (drafts: readonly MemoryProjectionDraft[]) => {
    result: MemoryProjectionResult;
    remember: () => void;
  };
} {
  const current = vault
    .prepare(
      `SELECT m.memory_id, m.kind, m.title_hint, m.day_key, m.place_id,
              m.started_at, m.ended_at, mm.asset_id, mm.ordinal
         FROM media_memory m
         LEFT JOIN media_memory_member mm ON mm.memory_id = m.memory_id
        ORDER BY m.memory_id, mm.ordinal`
    )
    .all() as unknown as ProjectionRow[];
  const currentFingerprint = fingerprintOf(source, current);
  const memo = lastPassByVault.get(vault);
  return {
    reused:
      memo?.fingerprint === currentFingerprint
        ? { ...memo.counts, reused: true }
        : null,
    finish: (drafts) => {
      const desired = rowsOf(drafts);
      const counts: Counts = {
        onThisDay: drafts.filter((draft) => draft.kind === "on-this-day")
          .length,
        trips: drafts.filter((draft) => draft.kind === "trip").length,
        similar: drafts.filter((draft) => draft.kind === "similar").length,
        members: desired.length,
      };
      const desiredFingerprint = fingerprintOf(source, desired);
      const reused = desiredFingerprint === currentFingerprint;
      return {
        result: { ...counts, reused },
        remember: () => {
          lastPassByVault.set(vault, {
            fingerprint: desiredFingerprint,
            counts,
          });
        },
      };
    },
  };
}
