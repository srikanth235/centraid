import { countPhotoEmbeddings, rankLivePhotoEmbeddings } from "@centraid/vault";
import type { PhotoEmbeddingHit, VaultDb } from "@centraid/vault";

import { hasSqliteVec } from "./sqlite-vec.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const RANKING_CANDIDATES = 500;

export type PhotoSearchHit = PhotoEmbeddingHit;

export type PhotoSearchOutcome =
  | { status: "ok"; model: string; hits: PhotoSearchHit[] }
  | { status: "unavailable"; reason: string };

export type PhotoSearchEngine = "vec" | "scan";

export interface PhotoSearchOptions {
  embedQuery: (
    query: string
  ) => Promise<
    | { status: "ok"; model: string; vector: number[] }
    | { status: "unavailable"; reason: string }
  >;
  query: string;
  limit?: number;
  engine?: PhotoSearchEngine;
}

export async function searchPhotosByText(
  db: VaultDb,
  options: PhotoSearchOptions
): Promise<PhotoSearchOutcome> {
  const embedded = await options.embedQuery(options.query);
  if (embedded.status === "unavailable") return embedded;
  if (countPhotoEmbeddings(db.vault, embedded.model) === 0) {
    return {
      status: "unavailable",
      reason: `no photos are indexed for ${embedded.model} yet — the embed-image automation indexes them in the background`,
    };
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT)),
    MAX_SEARCH_LIMIT
  );
  const hits = rankLivePhotoEmbeddings(db.vault, {
    model: embedded.model,
    vector: embedded.vector,
    engine: options.engine ?? (hasSqliteVec(db.vault) ? "vec" : "scan"),
    limit,
    candidates: RANKING_CANDIDATES,
  });
  return { status: "ok", model: embedded.model, hits };
}
