export type BackupState =
  | "local-only"
  | "queued"
  | "uploading"
  | "backed-up"
  | "remote-only";

export interface PhotoAsset {
  id: string;
  assetId?: string;
  contentId?: string;
  placeId?: string;
  captureGroupId?: string;
  liveVideoUri?: string;
  localId?: string;
  localIds?: string[];
  assetIds?: string[];
  uri: string;
  previewUri: string;
  originalUri: string;
  filename?: string;
  sha256?: string;
  phash?: string;
  thumbhash?: string;
  capturedAt?: string;
  tzOffsetMin?: number;
  kind: "photo" | "video" | "audio" | "scan";
  width?: number;
  height?: number;
  durationS?: number;
  fileSize?: number;
  exif?: Record<string, unknown>;
  favorite: boolean;
  archived: boolean;
  deleted: boolean;
  purgeAt?: string;
  backupState: BackupState;
  verifiedCasAck?: boolean;
  duplicateHint?: boolean;
  source: "device" | "replica" | "merged";
  sourceVaultId?: string;
  scopeIds?: string[];
  scopeLabels?: string[];
  writableScopeIds?: string[];
  canWrite?: boolean;
}

export interface PhotoSection {
  day: string;
  title: string;
  month: string;
  monthTitle: string;
  assets: PhotoAsset[];
}

function withLocalId(
  existing: readonly string[] | undefined,
  localId?: string
): string[] {
  const ids = existing ? [...existing] : [];
  if (localId && !ids.includes(localId)) ids.push(localId);
  return ids;
}

function foldedAssetIds(...assets: readonly PhotoAsset[]): string[] {
  return unique(
    assets.flatMap((asset) => [
      ...(asset.assetIds ?? []),
      ...(asset.assetId ? [asset.assetId] : []),
    ])
  );
}

export function mergePhotoAssets(
  device: PhotoAsset[],
  remote: PhotoAsset[]
): PhotoAsset[] {
  const merged: PhotoAsset[] = [];
  const remoteIndex = new Map<string, number>();
  for (const asset of remote) {
    const key = asset.sha256 ? `sha:${asset.sha256}` : `id:${asset.id}`;
    const position = remoteIndex.get(key);
    if (position === undefined) {
      remoteIndex.set(key, merged.length);
      merged.push({ ...asset, assetIds: foldedAssetIds(asset) });
      continue;
    }
    const current = merged[position]!;
    const canonical =
      current.canWrite !== true && asset.canWrite === true ? asset : current;
    merged[position] = {
      ...canonical,
      assetIds: foldedAssetIds(current, asset),
      scopeIds: unique([
        ...(current.scopeIds ?? []),
        ...(asset.scopeIds ?? []),
      ]),
      scopeLabels: unique([
        ...(current.scopeLabels ?? []),
        ...(asset.scopeLabels ?? []),
      ]),
      writableScopeIds: unique([
        ...(current.writableScopeIds ?? []),
        ...(asset.writableScopeIds ?? []),
      ]),
      canWrite: current.canWrite === true || asset.canWrite === true,
    };
  }
  const indexBySha = new Map<string, number>();
  merged.forEach((asset, index) => {
    if (asset.sha256 !== undefined && !indexBySha.has(asset.sha256))
      indexBySha.set(asset.sha256, index);
  });
  const remotePhash = new Set(
    remote.flatMap((asset) => (asset.phash ? [asset.phash] : []))
  );
  for (const local of device) {
    const index =
      local.sha256 === undefined ? undefined : indexBySha.get(local.sha256);
    if (index !== undefined) {
      const existing = merged[index]!;
      merged[index] =
        existing.source === "merged"
          ? {
              ...existing,
              localIds: withLocalId(existing.localIds, local.localId),
              verifiedCasAck: existing.verifiedCasAck || local.verifiedCasAck,
            }
          : {
              ...existing,
              localId: local.localId,
              localIds: withLocalId(undefined, local.localId),
              originalUri: local.originalUri,
              fileSize: local.fileSize ?? existing.fileSize,
              source: "merged",
              backupState: "backed-up",
              verifiedCasAck: local.verifiedCasAck,
            };
      continue;
    }
    merged.push({
      ...local,
      localIds: withLocalId(undefined, local.localId),
      duplicateHint: Boolean(local.phash && remotePhash.has(local.phash)),
    });
  }
  const phashCounts = new Map<string, number>();
  for (const asset of merged) {
    if (asset.phash)
      phashCounts.set(asset.phash, (phashCounts.get(asset.phash) ?? 0) + 1);
  }
  const sorted = merged
    .map((asset) => ({
      ...asset,
      duplicateHint:
        asset.duplicateHint ||
        Boolean(asset.phash && (phashCounts.get(asset.phash) ?? 0) > 1),
    }))
    .sort((a, b) => {
      if (a.capturedAt === undefined && b.capturedAt === undefined) return 0;
      if (a.capturedAt === undefined) return 1;
      if (b.capturedAt === undefined) return -1;
      return a.capturedAt < b.capturedAt
        ? 1
        : a.capturedAt > b.capturedAt
          ? -1
          : 0;
    });
  const liveVideos = new Map(
    sorted.flatMap((asset) =>
      asset.captureGroupId && asset.kind === "video"
        ? [[asset.captureGroupId, asset.originalUri] as const]
        : []
    )
  );
  const livePhotos = new Set(
    sorted.flatMap((asset) =>
      asset.captureGroupId && asset.kind === "photo"
        ? [asset.captureGroupId]
        : []
    )
  );
  return sorted.flatMap((asset) => {
    if (
      asset.captureGroupId &&
      asset.kind === "video" &&
      livePhotos.has(asset.captureGroupId)
    )
      return [];
    const liveVideoUri = asset.captureGroupId
      ? liveVideos.get(asset.captureGroupId)
      : undefined;
    return [{ ...asset, ...(liveVideoUri ? { liveVideoUri } : {}) }];
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function captureLocalDay(
  capturedAt: string,
  tzOffsetMin?: number
): string {
  if (tzOffsetMin != null) {
    return new Date(Date.parse(capturedAt) + tzOffsetMin * 60_000)
      .toISOString()
      .slice(0, 10);
  }
  const local = new Date(capturedAt);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const UNDATED_SECTION_DAY = "undated";

export function sectionPhotoAssets(
  assets: PhotoAsset[],
  now = new Date()
): PhotoSection[] {
  const sections = new Map<string, PhotoAsset[]>();
  const undated: PhotoAsset[] = [];
  for (const asset of assets.filter(
    (item) => !item.archived && !item.deleted
  )) {
    if (asset.capturedAt === undefined) {
      undated.push(asset);
      continue;
    }
    const day = captureLocalDay(asset.capturedAt, asset.tzOffsetMin);
    const bucket = sections.get(day) ?? [];
    bucket.push(asset);
    sections.set(day, bucket);
  }
  const dayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const dayWithYearFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const monthFormat = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  });
  const currentYear = now.getFullYear();
  const dated = [...sections.entries()].map(([day, rows]) => {
    const sameYear = new Date(day).getFullYear() === currentYear;
    return {
      day,
      title: (sameYear ? dayFormat : dayWithYearFormat).format(
        new Date(`${day}T12:00:00`)
      ),
      month: day.slice(0, 7),
      monthTitle: monthFormat.format(
        new Date(`${day.slice(0, 7)}-01T12:00:00`)
      ),
      assets: rows,
    };
  });
  if (undated.length === 0) return dated;
  return [
    ...dated,
    {
      day: UNDATED_SECTION_DAY,
      title: "Undated",
      month: UNDATED_SECTION_DAY,
      monthTitle: "Undated",
      assets: undated,
    },
  ];
}

export function onThisDay(
  assets: PhotoAsset[],
  now = new Date()
): PhotoAsset[] {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return assets.filter((asset) => {
    if (asset.capturedAt === undefined) return false;
    const [year, capturedMonth, capturedDay] = captureLocalDay(
      asset.capturedAt,
      asset.tzOffsetMin
    )
      .split("-")
      .map(Number);
    return (
      year! < now.getFullYear() &&
      capturedMonth === month &&
      capturedDay === day
    );
  });
}

export function addDragSelection(
  selection: ReadonlySet<string>,
  assetId: string
): Set<string> {
  return selection.has(assetId)
    ? new Set(selection)
    : new Set([...selection, assetId]);
}
