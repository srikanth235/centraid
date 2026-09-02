// Import review as a pure projection: a plane disposition becomes one of §6's
// three verdicts here and nowhere else. THE VAULT WINS — `held` is the promise
// that an import never overwrites a stored secret, and `merge-candidate` wears
// it deliberately: an unresolved match may not touch one.

export type ImportVerdictKey = "new" | "gapfill" | "held";

export const LOCKER_ENTITY = "locker.item";

export interface StagedRow {
  seq: number;
  entityType: string;
  externalId: string;
  disposition: string;
  note?: string | null;
  mapping?: string;
}

export interface StagedBatch {
  batchId: string;
  status: string;
  createdAt: string;
  summary?: Record<string, number>;
  kind?: string | null;
  label?: string | null;
}

export function verdictOf(disposition: string): ImportVerdictKey {
  if (disposition === "create") return "new";
  if (disposition === "update") return "gapfill";
  return "held";
}

export function draftBatches(batches: readonly StagedBatch[]): StagedBatch[] {
  return batches
    .filter((batch) => batch.status === "draft")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function verdictCounts(
  rows: readonly StagedRow[]
): Record<ImportVerdictKey, number> {
  const counts: Record<ImportVerdictKey, number> = {
    new: 0,
    gapfill: 0,
    held: 0,
  };
  for (const row of rows) counts[verdictOf(row.disposition)] += 1;
  return counts;
}

export function batchMeta(batch: StagedBatch): string {
  const total = Object.values(batch.summary ?? {}).reduce(
    (sum, n) => sum + n,
    0
  );
  return [
    batch.label ?? batch.kind ?? "a password-manager file",
    `${total} rows`,
    `staged ${String(batch.createdAt).slice(0, 10)}`,
  ].join("  ·  ");
}

export function publishedCopy(result: {
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: unknown[];
}): string {
  const failed = result.failed?.length ?? 0;
  return [
    `${result.created ?? 0} new`,
    `${result.updated ?? 0} filled`,
    `${result.skipped ?? 0} held — the vault won`,
    ...(failed > 0 ? [`${failed} failed`] : []),
  ].join(" · ");
}
