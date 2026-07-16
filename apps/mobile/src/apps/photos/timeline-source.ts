import { useEffect, useMemo, useState } from 'react';
import * as MediaLibrary from 'expo-media-library';
import type { ReplicaRow } from '@centraid/client/replica/native';

import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { UploadQueue } from '../../lib/upload/native-queue';
import { authHeader } from '../../lib/gateway';
import {
  mergePhotoAssets,
  sectionPhotoAssets,
  type PhotoAsset,
  type PhotoSection,
} from './timeline-model';
export type { BackupState, PhotoAsset, PhotoSection } from './timeline-model';

function value<T>(row: ReplicaRow, key: string): T | undefined {
  return row[key] as T | undefined;
}

function parseExif(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function useDeviceLibrary(): { rows: PhotoAsset[]; loading: boolean; permission: string } {
  const [rows, setRows] = useState<PhotoAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo', 'video'],
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let current = permission;
      if (!current || current.status === 'undetermined') current = await requestPermission();
      if (current.status !== 'granted') {
        if (!cancelled) setLoading(false);
        return;
      }
      let after: string | undefined;
      let first = true;
      do {
        const page = await MediaLibrary.getAssetsAsync({
          first: first ? 250 : 1_000,
          ...(after ? { after } : {}),
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        const next = page.assets.map<PhotoAsset>((asset) => ({
          id: `device:${asset.id}`,
          localId: asset.id,
          uri: asset.uri,
          previewUri: asset.uri,
          originalUri: asset.uri,
          ...(asset.filename ? { filename: asset.filename } : {}),
          capturedAt: new Date(asset.creationTime).toISOString(),
          kind: asset.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
          width: asset.width,
          height: asset.height,
          durationS: asset.duration,
          fileSize: 'fileSize' in asset ? Number(asset.fileSize) : undefined,
          favorite: false,
          archived: false,
          deleted: false,
          backupState: 'local-only',
          source: 'device',
        }));
        if (!cancelled) {
          setRows((existing) => (after ? [...existing, ...next] : next));
          if (first) setLoading(false);
        }
        first = false;
        after = page.hasNextPage ? page.endCursor : undefined;
      } while (after && !cancelled);
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [permission, requestPermission]);

  return { rows, loading, permission: permission?.status ?? 'undetermined' };
}

export function usePhotoTimeline(): {
  assets: PhotoAsset[];
  sections: PhotoSection[];
  loading: boolean;
  permission: string;
  error?: string;
} {
  const { gatewayBase } = useReplica();
  const assetsQuery = useMemo(() => ({ entity: 'media.media_asset' }), []);
  const contentQuery = useMemo(() => ({ entity: 'core.content_item' }), []);
  const derivativeQuery = useMemo(() => ({ entity: 'core.content_derivative' }), []);
  const phashQuery = useMemo(() => ({ entity: 'media.asset_phash' }), []);
  const assets = useReplicaQuery('photos', assetsQuery);
  const content = useReplicaQuery('photos', contentQuery);
  const derivatives = useReplicaQuery('photos', derivativeQuery);
  const phashes = useReplicaQuery('photos', phashQuery);
  const device = useDeviceLibrary();
  const uploadByUri = useMemo(() => {
    if (!gatewayBase)
      return new Map<
        string,
        { sha256: string; state: string; receipt?: Record<string, unknown> }
      >();
    const queue = UploadQueue.open({ gatewayBaseUrl: gatewayBase, headers: authHeader });
    try {
      return new Map(
        queue
          .all()
          .map((item) => [
            item.localUri,
            { sha256: item.sha256, state: item.state, receipt: item.receipt },
          ]),
      );
    } finally {
      queue.close();
    }
  }, [gatewayBase]);
  const deviceWithQueue = useMemo(
    () =>
      device.rows.map((asset) => {
        const upload = uploadByUri.get(asset.originalUri);
        if (!upload) return asset;
        const backupState =
          upload.state === 'settled'
            ? 'backed-up'
            : upload.state === 'uploading' || upload.state === 'completing'
              ? 'uploading'
              : 'queued';
        return {
          ...asset,
          sha256: upload.sha256,
          backupState,
          verifiedCasAck: upload.state === 'settled' && upload.receipt?.casAck === 'replicated',
        } as PhotoAsset;
      }),
    [device.rows, uploadByUri],
  );

  const remote = useMemo(() => {
    const contentById = new Map(content.rows.map((row) => [value<string>(row, 'content_id'), row]));
    const derivativesByContent = new Map<string, ReplicaRow[]>();
    for (const row of derivatives.rows) {
      const id = value<string>(row, 'content_id');
      if (!id) continue;
      derivativesByContent.set(id, [...(derivativesByContent.get(id) ?? []), row]);
    }
    const phashByAsset = new Map(
      phashes.rows.map((row) => [value<string>(row, 'asset_id'), value<string>(row, 'phash')]),
    );
    return assets.rows.flatMap<PhotoAsset>((asset) => {
      const contentId = value<string>(asset, 'content_id');
      const assetId = value<string>(asset, 'asset_id');
      const item = contentId ? contentById.get(contentId) : undefined;
      const sha = item ? value<string>(item, 'sha256') : undefined;
      if (!contentId || !assetId || !sha) return [];
      const rungs = derivativesByContent.get(contentId) ?? [];
      const thumbhash = rungs.find((row) => value(row, 'variant') === 'thumbhash');
      const kind = (value<string>(asset, 'kind') ?? 'photo') as PhotoAsset['kind'];
      const original = gatewayBase
        ? `${gatewayBase}/centraid/_vault/blobs/${encodeURIComponent(contentId)}`
        : '';
      const thumb = gatewayBase
        ? `${original}?variant=${kind === 'video' ? 'poster' : 'thumb'}`
        : original;
      const capturedAt = value<string>(asset, 'captured_at') ?? value<string>(item!, 'created_at');
      const exifJson = value<string>(asset, 'exif_json');
      return [
        {
          id: `replica:${assetId}`,
          assetId,
          contentId,
          placeId: value<string>(asset, 'place_id'),
          captureGroupId: value<string>(asset, 'capture_group_id'),
          uri: thumb,
          previewUri: gatewayBase ? `${original}?variant=preview` : original,
          originalUri: original,
          filename: value<string>(item!, 'title'),
          sha256: sha,
          phash: phashByAsset.get(assetId),
          thumbhash: thumbhash ? value<string>(thumbhash, 'text_content') : undefined,
          capturedAt: capturedAt ?? new Date(0).toISOString(),
          tzOffsetMin: value<number>(asset, 'tz_offset_min'),
          kind,
          width: value<number>(asset, 'width'),
          height: value<number>(asset, 'height'),
          durationS: value<number>(asset, 'duration_s'),
          fileSize: value<number>(item!, 'byte_size'),
          exif: parseExif(exifJson),
          favorite: value<number>(asset, 'favorite') === 1,
          archived: Boolean(value<string>(asset, 'archived_at')),
          deleted: Boolean(value<string>(asset, 'deleted_at')),
          backupState: 'remote-only',
          source: 'replica',
        },
      ];
    });
  }, [assets.rows, content.rows, derivatives.rows, gatewayBase, phashes.rows]);

  const merged = useMemo(
    () => mergePhotoAssets(deviceWithQueue, remote),
    [deviceWithQueue, remote],
  );
  return {
    assets: merged,
    sections: useMemo(() => sectionPhotoAssets(merged), [merged]),
    loading: device.loading && assets.loading,
    permission: device.permission,
    ...(assets.error ? { error: assets.error } : {}),
  };
}
