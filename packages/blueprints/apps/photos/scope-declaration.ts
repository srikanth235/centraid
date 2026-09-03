import type { ScopeAppDeclaration } from "../_shared/scope-kit.ts";

export interface MergeableAsset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
  [key: string]: unknown;
}

export const photosScopeDeclaration: ScopeAppDeclaration<MergeableAsset> = {
  mergeKey: (asset) => asset.taken_at ?? null,
  mintedIdFamilies: [
    "media.asset",
    "core.collection",
    "core.place",
    "media.memory",
  ],
  projectionIngest: "photos.reingest",
};

export function photoDedupeIdentity(asset: MergeableAsset): string {
  return asset.sha256 != null && asset.sha256 !== ""
    ? `sha:${asset.sha256}`
    : `content:${asset.content_id}`;
}
