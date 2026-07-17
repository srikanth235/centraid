// One shared timeline instance for the whole Photos stack (#419, finding 5).
//
// Every Photos screen used to run its own `usePhotoTimeline`, so opening the
// lightbox or the library kicked off another full replica read *and* another
// 50k-row MediaLibrary re-walk, with several concurrent copies of the merged
// array alive under the native stack. This module is that work, done once: a
// process-singleton engine that reads the replica, walks the camera roll and
// folds the upload queue in, then publishes an immutable snapshot every screen
// subscribes to via `useSyncExternalStore`. It is driven imperatively (the
// session exposes `read`/`subscribe` directly) so it needs no React tree of its
// own and survives screen mount/unmount — the hook API is unchanged.

import * as MediaLibrary from 'expo-media-library';
import type { ReplicaRow } from '@centraid/client/replica/native';

import { authHeader } from '../../lib/gateway';
import type { NativeReplicaSession } from '../../lib/replica/native-session';
import { UploadQueue } from '../../lib/upload/native-queue';
import {
  mergePhotoAssets,
  sectionPhotoAssets,
  type BackupState,
  type PhotoAsset,
  type PhotoSection,
} from './timeline-model';

export interface TimelineSnapshot {
  assets: PhotoAsset[];
  sections: PhotoSection[];
  loading: boolean;
  permission: string;
  error?: string;
}

const EMPTY: TimelineSnapshot = {
  assets: [],
  sections: [],
  loading: true,
  permission: 'undetermined',
};

interface UploadEntry {
  sha256: string;
  state: string;
  receipt?: Record<string, unknown>;
}

const REPLICA_ENTITIES = [
  'media.media_asset',
  'core.content_item',
  'core.content_derivative',
  'media.asset_phash',
] as const;

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

class PhotoTimelineEngine {
  #subscribers = new Set<() => void>();
  #refs = 0;
  #session?: NativeReplicaSession;
  #gatewayBase?: string;
  #generation = 0;
  #unsubscribe?: () => void;
  #pollTimer?: ReturnType<typeof setInterval>;

  #assetRows: ReplicaRow[] = [];
  #contentRows: ReplicaRow[] = [];
  #derivativeRows: ReplicaRow[] = [];
  #phashRows: ReplicaRow[] = [];
  #deviceRows: PhotoAsset[] = [];
  #uploadByUri = new Map<string, UploadEntry>();
  #uploadSignature = '';
  #permission = 'undetermined';
  #deviceLoading = true;
  #replicaLoading = true;
  #deviceStarted = false;
  #error?: string;

  #snapshot: TimelineSnapshot = EMPTY;

  getSnapshot = (): TimelineSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  };

  /**
   * Register a mounted screen. Ref-counted so the engine only tears down when
   * the last Photos screen leaves — kept separate from `setSession` so a
   * gateway-base change never bounces the ref count and re-walks the library.
   */
  acquire(): () => void {
    this.#refs += 1;
    if (this.#refs === 1 && !this.#pollTimer) {
      // Flip queued → backed-up badges without a remount: the upload queue is a
      // separate SQLite db the drainer mutates, so poll it while any screen is up.
      this.#pollTimer = setInterval(() => this.refreshUploads(), 4_000);
    }
    return () => {
      this.#refs -= 1;
      if (this.#refs <= 0) this.teardown();
    };
  }

  setSession(session: NativeReplicaSession | undefined, gatewayBase: string | undefined): void {
    const sessionChanged = session !== this.#session;
    const baseChanged = gatewayBase !== this.#gatewayBase;
    this.#session = session;
    this.#gatewayBase = gatewayBase;
    if (!session) return;
    if (sessionChanged) {
      this.#generation += 1;
      this.#unsubscribe?.();
      this.#replicaLoading = true;
      this.#unsubscribe = session.subscribe('photos', () => void this.readReplica());
      void this.readReplica();
    }
    if (sessionChanged || baseChanged) this.refreshUploads();
    // A base change (tunnel port moved) leaves device/replica rows intact but
    // rewrites every remote URL, so re-derive without re-walking the library.
    if (baseChanged && !sessionChanged) this.recompute();
    if (!this.#deviceStarted) {
      this.#deviceStarted = true;
      void this.walkDevice(this.#generation);
    }
  }

  /** Re-read the durable upload queue; recompute only when something changed. */
  refreshUploads(): void {
    const base = this.#gatewayBase;
    let next = new Map<string, UploadEntry>();
    if (base) {
      const queue = UploadQueue.open({ gatewayBaseUrl: base, headers: authHeader });
      try {
        next = new Map(
          queue
            .all()
            .map((item) => [
              item.localUri,
              { sha256: item.sha256, state: item.state, receipt: item.receipt },
            ]),
        );
      } catch {
        return;
      } finally {
        queue.close();
      }
    }
    const signature = [...next.entries()]
      .map(([uri, entry]) => `${uri}:${entry.state}:${entry.receipt?.casAck ?? ''}`)
      .sort()
      .join('|');
    if (signature === this.#uploadSignature) return;
    this.#uploadSignature = signature;
    this.#uploadByUri = next;
    this.recompute();
  }

  private async readReplica(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const generation = this.#generation;
    try {
      const [assets, content, derivatives, phashes] = await Promise.all(
        REPLICA_ENTITIES.map((entity) => session.read('photos', { entity })),
      );
      if (generation !== this.#generation) return;
      this.#assetRows = assets!.rows.map((row) => row.values);
      this.#contentRows = content!.rows.map((row) => row.values);
      this.#derivativeRows = derivatives!.rows.map((row) => row.values);
      this.#phashRows = phashes!.rows.map((row) => row.values);
      this.#error = undefined;
      this.#replicaLoading = false;
      this.recompute();
    } catch (reason) {
      if (generation !== this.#generation) return;
      this.#error = reason instanceof Error ? reason.message : String(reason);
      this.#replicaLoading = false;
      this.recompute();
    }
  }

  private async walkDevice(generation: number): Promise<void> {
    try {
      let permission = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
      if (permission.status === 'undetermined') {
        permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
      }
      if (generation !== this.#generation) return;
      this.#permission = permission.status;
      if (permission.status !== 'granted') {
        this.#deviceLoading = false;
        this.recompute();
        return;
      }
      const rows: PhotoAsset[] = [];
      let after: string | undefined;
      let first = true;
      do {
        const page = await MediaLibrary.getAssetsAsync({
          first: first ? 250 : 1_000,
          ...(after ? { after } : {}),
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        if (generation !== this.#generation) return;
        for (const asset of page.assets) {
          rows.push({
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
          });
        }
        this.#deviceRows = [...rows];
        if (first) this.#deviceLoading = false;
        first = false;
        this.recompute();
        after = page.hasNextPage ? page.endCursor : undefined;
      } while (after);
    } catch {
      if (generation !== this.#generation) return;
      this.#deviceLoading = false;
      this.recompute();
    }
  }

  private recompute(): void {
    const base = this.#gatewayBase;
    const deviceWithQueue = this.#deviceRows.map((asset) => {
      const upload = this.#uploadByUri.get(asset.originalUri);
      if (!upload) return asset;
      const backupState: BackupState =
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
      };
    });

    const contentById = new Map(
      this.#contentRows.map((row) => [value<string>(row, 'content_id'), row]),
    );
    const derivativesByContent = new Map<string, ReplicaRow[]>();
    for (const row of this.#derivativeRows) {
      const id = value<string>(row, 'content_id');
      if (!id) continue;
      derivativesByContent.set(id, [...(derivativesByContent.get(id) ?? []), row]);
    }
    const phashByAsset = new Map(
      this.#phashRows.map((row) => [value<string>(row, 'asset_id'), value<string>(row, 'phash')]),
    );
    const remote = this.#assetRows.flatMap<PhotoAsset>((asset) => {
      const contentId = value<string>(asset, 'content_id');
      const assetId = value<string>(asset, 'asset_id');
      const item = contentId ? contentById.get(contentId) : undefined;
      const sha = item ? value<string>(item, 'sha256') : undefined;
      if (!contentId || !assetId || !sha) return [];
      const rungs = derivativesByContent.get(contentId) ?? [];
      const thumbhash = rungs.find((row) => value(row, 'variant') === 'thumbhash');
      const kind = (value<string>(asset, 'kind') ?? 'photo') as PhotoAsset['kind'];
      const original = base ? `${base}/centraid/_vault/blobs/${encodeURIComponent(contentId)}` : '';
      const thumb = base
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
          previewUri: base ? `${original}?variant=preview` : original,
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

    const assets = mergePhotoAssets(deviceWithQueue, remote);
    this.#snapshot = {
      assets,
      sections: sectionPhotoAssets(assets),
      loading: this.#deviceLoading && this.#replicaLoading,
      permission: this.#permission,
      ...(this.#error ? { error: this.#error } : {}),
    };
    for (const listener of this.#subscribers) listener();
  }

  private teardown(): void {
    this.#refs = 0;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#generation += 1;
    this.#session = undefined;
    this.#gatewayBase = undefined;
    this.#deviceStarted = false;
    this.#deviceLoading = true;
    this.#replicaLoading = true;
    this.#assetRows = [];
    this.#contentRows = [];
    this.#derivativeRows = [];
    this.#phashRows = [];
    this.#deviceRows = [];
    this.#uploadByUri = new Map();
    this.#uploadSignature = '';
    this.#error = undefined;
    this.#snapshot = EMPTY;
  }
}

export const photoTimelineEngine = new PhotoTimelineEngine();
