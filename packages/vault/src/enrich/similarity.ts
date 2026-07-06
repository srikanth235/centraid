// Similarity primitives (issue #299): the perceptual-hash distance function
// SQL can call, and the pure-JS cosine scan behind semantic search.
//
// `vault_hamming` is registered as an app-defined SQLite function beside
// `vault_content_text` — near-duplicate detection is then one query:
//   SELECT ... WHERE vault_hamming(a.phash, b.phash) <= 6
// Hashes are hex strings (producer-agnostic: the client canvas computes a
// 64-bit dHash today; a server codec plug-in may later). Mismatched lengths
// and NULLs are "not comparable", never an error — the function returns NULL
// and SQL three-valued logic drops the row.
//
// The embedding scan is deliberately brute-force float32 cosine: a personal
// vault holds thousands of rows, not billions, and an exact scan keeps the
// index additive (issue #299 phase 5 — nothing else may depend on it).

import type { DatabaseSync } from 'node:sqlite';

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

/** Hamming distance between two equal-length hex strings, else null. */
export function hexHamming(a: unknown, b: unknown): number | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
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

/** Register `vault_hamming` on a vault connection. */
export function registerHammingFn(db: DatabaseSync): void {
  db.function('vault_hamming', { deterministic: true }, hexHamming);
}

/** Little-endian float32 encode — the `enrich_embedding.vector` BLOB shape. */
export function encodeVector(values: readonly number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

export function decodeVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

/** Cosine similarity of a query against one stored vector; NaN-safe. */
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

export interface SemanticHit {
  entityType: string;
  entityId: string;
  score: number;
}

/**
 * Exact cosine scan over `enrich_embedding` for one model, optionally
 * filtered to entity types. Callers own consent — the gateway filters hits
 * to rows the caller may read before returning them.
 */
export function scanEmbeddings(
  vault: DatabaseSync,
  model: string,
  query: readonly number[],
  options: { entityTypes?: readonly string[]; limit?: number } = {},
): SemanticHit[] {
  const q = Float32Array.from(query);
  const types = options.entityTypes?.length
    ? ` AND entity_type IN (${options.entityTypes.map(() => '?').join(',')})`
    : '';
  const rows = vault
    .prepare(`SELECT entity_type, entity_id, vector FROM enrich_embedding WHERE model = ?${types}`)
    .all(model, ...(options.entityTypes ?? [])) as {
    entity_type: string;
    entity_id: string;
    vector: Uint8Array;
  }[];
  const hits = rows.map((r) => ({
    entityType: r.entity_type,
    entityId: r.entity_id,
    score: cosine(q, decodeVector(Buffer.from(r.vector))),
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}
