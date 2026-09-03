import type { DatabaseSync } from "node:sqlite";

const POPCOUNT_NIBBLE = [
  0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4,
] as const;

export function hexHamming(a: unknown, b: unknown): number | null {
  if (typeof a !== "string" || typeof b !== "string") return null;
  if (a.length === 0 || a.length !== b.length) return null;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const na = Number.parseInt(a[i]!, 16);
    const nb = Number.parseInt(b[i]!, 16);
    if (Number.isNaN(na) || Number.isNaN(nb)) return null;
    distance += POPCOUNT_NIBBLE[(na ^ nb) & 0xf]!;
  }
  return distance;
}

export function registerHammingFn(db: DatabaseSync): void {
  db.function("vault_hamming", { deterministic: true }, hexHamming);
}

export function encodeVector(values: readonly number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

export function decodeVector(blob: Buffer): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    Math.floor(blob.byteLength / 4)
  );
}

export function cosine(query: Float32Array, stored: Float32Array): number {
  if (query.length !== stored.length || query.length === 0) return 0;
  let dot = 0;
  let nq = 0;
  let ns = 0;
  for (let i = 0; i < query.length; i++) {
    dot += query[i]! * stored[i]!;
    nq += query[i]! * query[i]!;
    ns += stored[i]! * stored[i]!;
  }
  if (nq === 0 || ns === 0) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(ns));
}

function float32Of(view: ArrayBufferView): Float32Array {
  if (view.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(
      view.buffer,
      view.byteOffset,
      Math.floor(view.byteLength / Float32Array.BYTES_PER_ELEMENT)
    );
  }
  return new Float32Array(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer
  );
}

export function registerCosineFn(db: DatabaseSync): void {
  db.function(
    "vault_cosine",
    { deterministic: true },
    (stored: unknown, query: unknown) => {
      if (!ArrayBuffer.isView(stored) || !ArrayBuffer.isView(query)) return 0;
      return cosine(float32Of(query), float32Of(stored));
    }
  );
}

export interface SemanticHit {
  entityType: string;
  entityId: string;
  score: number;
}

export interface ScanEmbeddingsOptions {
  entityTypes?: readonly string[];
  limit: number;
}

export function scanEmbeddings(
  vault: DatabaseSync,
  model: string,
  query: readonly number[],
  options: ScanEmbeddingsOptions
): SemanticHit[] {
  const limit = Math.max(1, Math.trunc(options.limit));
  const types = options.entityTypes?.length
    ? ` AND target_type IN (${options.entityTypes.map(() => "?").join(",")})`
    : "";
  return vault
    .prepare(
      `SELECT target_type AS "entityType", target_id AS "entityId",
              vault_cosine(vector, ?) AS score
         FROM enrich_embedding
        WHERE model = ?${types}
        ORDER BY score DESC
        LIMIT ?`
    )
    .all(
      encodeVector(query),
      model,
      ...(options.entityTypes ?? []),
      limit
    ) as unknown as SemanticHit[];
}

export interface RankEmbeddingsOptions {
  model: string;
  vector: readonly number[];
  entityTypes?: readonly string[];
  limit: number;
  candidates?: number;
}

export function rankEmbeddingsWithVec(
  vault: DatabaseSync,
  options: RankEmbeddingsOptions
): SemanticHit[] {
  const limit = Math.max(1, Math.trunc(options.limit));
  const candidates = Math.max(limit, Math.trunc(options.candidates ?? limit));
  const types = options.entityTypes?.length
    ? ` AND target_type IN (${options.entityTypes.map(() => "?").join(",")})`
    : "";
  const rows = vault
    .prepare(
      `SELECT target_type AS "entityType", target_id AS "entityId",
              vec_distance_cosine(vector, ?) AS distance
         FROM enrich_embedding
        WHERE model = ? AND dim = ?${types}
        ORDER BY distance
        LIMIT ?`
    )
    .all(
      encodeVector(options.vector),
      options.model,
      options.vector.length,
      ...(options.entityTypes ?? []),
      candidates
    ) as unknown as {
    entityType: string;
    entityId: string;
    distance: number;
  }[];
  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    score: 1 - row.distance,
  }));
}
