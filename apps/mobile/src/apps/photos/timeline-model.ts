export type BackupState = 'local-only' | 'queued' | 'uploading' | 'backed-up' | 'remote-only';

export interface PhotoAsset {
  id: string;
  assetId?: string;
  contentId?: string;
  placeId?: string;
  captureGroupId?: string;
  liveVideoUri?: string;
  localId?: string;
  /**
   * Every device copy that resolves to this asset's sha. A backed-up photo the
   * camera roll holds twice merges onto one timeline row; free-up-space must be
   * able to reach all of them, so the identity is a set, not a single id.
   */
  localIds?: string[];
  uri: string;
  previewUri: string;
  originalUri: string;
  filename?: string;
  sha256?: string;
  phash?: string;
  thumbhash?: string;
  capturedAt: string;
  tzOffsetMin?: number;
  kind: 'photo' | 'video' | 'audio' | 'scan';
  width?: number;
  height?: number;
  durationS?: number;
  fileSize?: number;
  exif?: Record<string, unknown>;
  favorite: boolean;
  archived: boolean;
  deleted: boolean;
  backupState: BackupState;
  verifiedCasAck?: boolean;
  duplicateHint?: boolean;
  source: 'device' | 'replica' | 'merged';
}

export interface PhotoSection {
  day: string;
  title: string;
  month: string;
  monthTitle: string;
  assets: PhotoAsset[];
}

function withLocalId(existing: readonly string[] | undefined, localId?: string): string[] {
  const ids = existing ? [...existing] : [];
  if (localId && !ids.includes(localId)) ids.push(localId);
  return ids;
}

export function mergePhotoAssets(device: PhotoAsset[], remote: PhotoAsset[]): PhotoAsset[] {
  const merged = [...remote];
  // sha → position in `merged`, so a second device copy of one sha folds onto
  // the same row instead of `indexOf(same)` returning -1 and dropping it. O(n).
  const indexBySha = new Map<string, number>();
  remote.forEach((asset, index) => {
    if (asset.sha256 !== undefined && !indexBySha.has(asset.sha256))
      indexBySha.set(asset.sha256, index);
  });
  const remotePhash = new Set(remote.flatMap((asset) => (asset.phash ? [asset.phash] : [])));
  for (const local of device) {
    const index = local.sha256 !== undefined ? indexBySha.get(local.sha256) : undefined;
    if (index !== undefined) {
      const existing = merged[index]!;
      merged[index] =
        existing.source === 'merged'
          ? // Already carries a device copy: keep the primary identity, just
            // widen the set so every camera-roll duplicate is reachable.
            {
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
              source: 'merged',
              backupState: 'backed-up',
              verifiedCasAck: local.verifiedCasAck,
            };
      continue;
    }
    // A perceptual hash is review evidence, never identity.
    merged.push({
      ...local,
      localIds: withLocalId(undefined, local.localId),
      duplicateHint: Boolean(local.phash && remotePhash.has(local.phash)),
    });
  }
  const phashCounts = new Map<string, number>();
  for (const asset of merged) {
    if (asset.phash) phashCounts.set(asset.phash, (phashCounts.get(asset.phash) ?? 0) + 1);
  }
  const sorted = merged
    .map((asset) => ({
      ...asset,
      duplicateHint:
        asset.duplicateHint || Boolean(asset.phash && (phashCounts.get(asset.phash) ?? 0) > 1),
    }))
    // `capturedAt` is always an ISO-8601 UTC string, which sorts correctly by
    // raw code-unit comparison — no per-comparison Date.parse across 50k rows.
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0));
  const liveVideos = new Map(
    sorted.flatMap((asset) =>
      asset.captureGroupId && asset.kind === 'video'
        ? [[asset.captureGroupId, asset.originalUri] as const]
        : [],
    ),
  );
  const livePhotos = new Set(
    sorted.flatMap((asset) =>
      asset.captureGroupId && asset.kind === 'photo' ? [asset.captureGroupId] : [],
    ),
  );
  return sorted.flatMap((asset) => {
    if (asset.captureGroupId && asset.kind === 'video' && livePhotos.has(asset.captureGroupId))
      return [];
    const liveVideoUri = asset.captureGroupId ? liveVideos.get(asset.captureGroupId) : undefined;
    return [{ ...asset, ...(liveVideoUri ? { liveVideoUri } : {}) }];
  });
}

/**
 * The calendar day a photo was taken, in the capture's own wall clock.
 *
 * Bucketing on the raw UTC slice files a 20:00 PDT photo under the next day.
 * When the vault carried the original `tzOffsetMin` we shift the instant into
 * that zone; otherwise we fall back to the viewing device's local day, which is
 * the same reference `onThisDay` uses — the two must always agree.
 */
export function captureLocalDay(capturedAt: string, tzOffsetMin?: number): string {
  if (tzOffsetMin != null) {
    return new Date(Date.parse(capturedAt) + tzOffsetMin * 60_000).toISOString().slice(0, 10);
  }
  const local = new Date(capturedAt);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function sectionPhotoAssets(assets: PhotoAsset[], now = new Date()): PhotoSection[] {
  const sections = new Map<string, PhotoAsset[]>();
  for (const asset of assets.filter((item) => !item.archived && !item.deleted)) {
    const day = captureLocalDay(asset.capturedAt, asset.tzOffsetMin);
    const bucket = sections.get(day) ?? [];
    bucket.push(asset);
    sections.set(day, bucket);
  }
  // Build one formatter of each kind, not two per day section (50k assets can
  // span thousands of days).
  const dayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const dayWithYearFormat = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const currentYear = now.getFullYear();
  return [...sections.entries()].map(([day, rows]) => {
    const sameYear = new Date(day).getFullYear() === currentYear;
    return {
      day,
      title: (sameYear ? dayFormat : dayWithYearFormat).format(new Date(`${day}T12:00:00`)),
      month: day.slice(0, 7),
      monthTitle: monthFormat.format(new Date(`${day.slice(0, 7)}-01T12:00:00`)),
      assets: rows,
    };
  });
}

export function onThisDay(assets: PhotoAsset[], now = new Date()): PhotoAsset[] {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return assets.filter((asset) => {
    // Same capture-local reference as sectioning, so a memory and its timeline
    // row never disagree about which day the photo belongs to.
    const [year, capturedMonth, capturedDay] = captureLocalDay(asset.capturedAt, asset.tzOffsetMin)
      .split('-')
      .map(Number);
    return year! < now.getFullYear() && capturedMonth === month && capturedDay === day;
  });
}

/** Accumulate a drag path without mutating the selection owned by React state. */
export function addDragSelection(selection: ReadonlySet<string>, assetId: string): Set<string> {
  return selection.has(assetId) ? new Set(selection) : new Set([...selection, assetId]);
}
