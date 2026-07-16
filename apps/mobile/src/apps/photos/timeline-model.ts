export type BackupState = 'local-only' | 'queued' | 'uploading' | 'backed-up' | 'remote-only';

export interface PhotoAsset {
  id: string;
  assetId?: string;
  contentId?: string;
  placeId?: string;
  captureGroupId?: string;
  liveVideoUri?: string;
  localId?: string;
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

export function mergePhotoAssets(device: PhotoAsset[], remote: PhotoAsset[]): PhotoAsset[] {
  const bySha = new Map(remote.flatMap((asset) => (asset.sha256 ? [[asset.sha256, asset]] : [])));
  const merged = [...remote];
  const remotePhash = new Set(remote.flatMap((asset) => (asset.phash ? [asset.phash] : [])));
  for (const local of device) {
    const same = local.sha256 ? bySha.get(local.sha256) : undefined;
    if (same) {
      const index = merged.indexOf(same);
      merged[index] = {
        ...same,
        localId: local.localId,
        originalUri: local.originalUri,
        fileSize: local.fileSize ?? same.fileSize,
        source: 'merged',
        backupState: 'backed-up',
        verifiedCasAck: local.verifiedCasAck,
      };
      continue;
    }
    // A perceptual hash is review evidence, never identity.
    merged.push({ ...local, duplicateHint: Boolean(local.phash && remotePhash.has(local.phash)) });
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
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
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

export function sectionPhotoAssets(assets: PhotoAsset[], now = new Date()): PhotoSection[] {
  const sections = new Map<string, PhotoAsset[]>();
  for (const asset of assets.filter((item) => !item.archived && !item.deleted)) {
    const day = asset.capturedAt.slice(0, 10);
    const bucket = sections.get(day) ?? [];
    bucket.push(asset);
    sections.set(day, bucket);
  }
  return [...sections.entries()].map(([day, rows]) => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    };
    if (new Date(day).getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return {
      day,
      title: new Intl.DateTimeFormat(undefined, options).format(new Date(`${day}T12:00:00`)),
      month: day.slice(0, 7),
      monthTitle: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
        new Date(`${day.slice(0, 7)}-01T12:00:00`),
      ),
      assets: rows,
    };
  });
}

export function onThisDay(assets: PhotoAsset[], now = new Date()): PhotoAsset[] {
  const month = now.getMonth();
  const day = now.getDate();
  return assets.filter((asset) => {
    const captured = new Date(asset.capturedAt);
    return (
      captured.getFullYear() < now.getFullYear() &&
      captured.getMonth() === month &&
      captured.getDate() === day
    );
  });
}

/** Accumulate a drag path without mutating the selection owned by React state. */
export function addDragSelection(selection: ReadonlySet<string>, assetId: string): Set<string> {
  return selection.has(assetId) ? new Set(selection) : new Set([...selection, assetId]);
}
