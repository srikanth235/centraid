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

import * as MediaLibrary from "expo-media-library";
import { AppState } from "react-native";

import type { ReplicaRow } from "@centraid/client/replica/native";

import { authHeader } from "../../lib/gateway";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { pinnedThumbnailUri } from "../../lib/replica/thumbnail-pack";
import { UploadQueue } from "../../lib/upload/native-queue";
import { capturedAtIso, durationSeconds } from "./device-media";
import { mergePhotoAssets, sectionPhotoAssets } from "./timeline-model";
import type { BackupState, PhotoAsset, PhotoSection } from "./timeline-model";

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
  permission: "undetermined",
};

interface UploadEntry {
  sha256: string;
  state: string;
  receipt?: Record<string, unknown>;
}

/** Poll rate while the queue has work; slow rate when it is settled. */
const ACTIVE_UPLOAD_POLL_MS = 4_000;
const IDLE_UPLOAD_POLL_MS = 30_000;

/**
 * How long the device walk lets pages accumulate before re-deriving the merged
 * timeline. Page one still recomputes immediately so the grid paints; after
 * that, a recompute per 1,000-row page meant merging and re-sectioning the
 * whole library ~50 times on the way to a 50k-photo roll.
 */
const WALK_RECOMPUTE_DEBOUNCE_MS = 250;

const REPLICA_ENTITIES = [
  "media.media_asset",
  "core.content_item",
  "core.content_derivative",
  "media.asset_phash",
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
  #session?: MobileReplicaSession;
  #gatewayBase?: string;
  #generation = 0;
  #unsubscribe?: () => void;
  #pollTimer?: ReturnType<typeof setInterval>;
  #appStateSub?: { remove: () => void };
  #queue?: UploadQueue;
  #queueBase?: string;
  #uploadsInFlight = false;
  #recomputeTimer?: ReturnType<typeof setTimeout>;

  #assetRows: ReplicaRow[] = [];
  #contentRows: ReplicaRow[] = [];
  #derivativeRows: ReplicaRow[] = [];
  #phashRows: ReplicaRow[] = [];
  #deviceRows: PhotoAsset[] = [];
  #uploadByUri = new Map<string, UploadEntry>();
  #uploadSignature = "";
  #permission = "undetermined";
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
    if (this.#refs === 1) {
      this.#appStateSub ??= AppState.addEventListener("change", (state) => {
        if (state === "active") {
          this.refreshUploads();
          this.startUploadPoll();
        } else this.stopUploadPoll();
      });
      if (AppState.currentState === "active") this.startUploadPoll();
    }
    return () => {
      this.#refs -= 1;
      if (this.#refs <= 0) this.teardown();
    };
  }

  /**
   * Flip queued → backed-up badges without a remount: the upload queue is a
   * separate SQLite database the drainer mutates, so it has to be observed.
   *
   * Two things make that cheap. The handle stays open for as long as any Photos
   * screen is mounted — opening and closing SQLite every four seconds was most
   * of the cost — and an idle queue drops to a slow poll, because a queue with
   * nothing in flight cannot change without the user adding to it. Nothing
   * polls at all while the app is in the background: there is no badge to
   * update and no screen to show it on.
   */
  private startUploadPoll(): void {
    if (this.#pollTimer || this.#refs === 0) return;
    this.#pollTimer = setInterval(
      () => this.refreshUploads(),
      this.#uploadsInFlight ? ACTIVE_UPLOAD_POLL_MS : IDLE_UPLOAD_POLL_MS
    );
  }

  private stopUploadPoll(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  setSession(
    session: MobileReplicaSession | undefined,
    gatewayBase: string | undefined
  ): void {
    const sessionChanged = session !== this.#session;
    const baseChanged = gatewayBase !== this.#gatewayBase;
    this.#session = session;
    this.#gatewayBase = gatewayBase;
    if (!session) return;
    if (sessionChanged) {
      this.#generation += 1;
      this.#unsubscribe?.();
      this.#replicaLoading = true;
      this.#unsubscribe = session.subscribe(
        "photos",
        () => void this.readReplica()
      );
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
    const queue = base ? this.uploadQueue(base) : undefined;
    if (queue) {
      try {
        next = new Map(
          queue
            .all()
            .map((item) => [
              item.localUri,
              { sha256: item.sha256, state: item.state, receipt: item.receipt },
            ])
        );
      } catch {
        // The long-lived handle went bad (device storage, a purge). Drop it so
        // the next tick reopens instead of polling a dead connection forever.
        this.closeUploadQueue();
        return;
      }
    }
    const inFlight = [...next.values()].some(
      (entry) => entry.state !== "settled"
    );
    if (inFlight !== this.#uploadsInFlight) {
      this.#uploadsInFlight = inFlight;
      // The poll interval is derived from this, so re-arm it at the new rate.
      this.stopUploadPoll();
      this.startUploadPoll();
    }
    const signature = [...next.entries()]
      .map(
        ([uri, entry]) => `${uri}:${entry.state}:${entry.receipt?.casAck ?? ""}`
      )
      .sort()
      .join("|");
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
        REPLICA_ENTITIES.map((entity) =>
          session.read("photos", { entity, limit: 100_000 })
        )
      );
      if (generation !== this.#generation) return;
      this.#assetRows = assets!.rows.map((row) => row.values);
      this.#contentRows = content!.rows.map((row) => row.values);
      this.#derivativeRows = derivatives!.rows.map((row) => row.values);
      this.#phashRows = phashes!.rows.map((row) => row.values);
      this.#error = undefined;
      this.#replicaLoading = false;
      this.recompute();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error = error instanceof Error ? error.message : String(error);
      this.#replicaLoading = false;
      this.recompute();
    }
  }

  private async walkDevice(generation: number): Promise<void> {
    try {
      let permission = await MediaLibrary.getPermissionsAsync(false, [
        "photo",
        "video",
      ]);
      if (permission.status === "undetermined") {
        permission = await MediaLibrary.requestPermissionsAsync(false, [
          "photo",
          "video",
        ]);
      }
      if (generation !== this.#generation) return;
      this.#permission = permission.status;
      if (permission.status !== "granted") {
        this.#deviceLoading = false;
        this.recompute();
        return;
      }
      const rows: PhotoAsset[] = [];
      // A small first page paints the grid fast; the rest walk in bigger bites.
      const loadPage = async (
        offset: number,
        pageSize: number
      ): Promise<void> => {
        const page = await new MediaLibrary.Query()
          .within(MediaLibrary.AssetField.MEDIA_TYPE, [
            MediaLibrary.MediaType.IMAGE,
            MediaLibrary.MediaType.VIDEO,
          ])
          .orderBy({
            key: MediaLibrary.AssetField.CREATION_TIME,
            ascending: false,
          })
          .limit(pageSize)
          .offset(offset)
          // ONE native round-trip per page, as the legacy paged read was.
          // `exe()` hands back Asset handles whose every field is a separate
          // async getter — seven more crossings per photo, which across a
          // 50k-photo library is 350k round-trips instead of ~50.
          .exeForMetadata();
        if (generation !== this.#generation) return;
        for (const metadata of page) {
          // The media-store id IS the addressable uri — `ph://…` on iOS,
          // `content://…` on Android — and both render directly in expo-image,
          // exactly as the legacy `asset.uri` did. A grid cell therefore still
          // costs no native call of its own; full-quality bytes are resolved
          // per asset, on demand, by `openDeviceOriginal`.
          rows.push({
            id: `device:${metadata.id}`,
            localId: metadata.id,
            uri: metadata.id,
            previewUri: metadata.id,
            originalUri: metadata.id,
            ...(metadata.filename ? { filename: metadata.filename } : {}),
            capturedAt: capturedAtIso(metadata),
            kind:
              metadata.mediaType === MediaLibrary.MediaType.VIDEO
                ? "video"
                : "photo",
            width: metadata.width ?? undefined,
            height: metadata.height ?? undefined,
            durationS: durationSeconds(metadata.duration),
            // Byte size is not part of the cheap metadata batch and is not
            // worth a per-photo round-trip here; the replica row carries it
            // once an asset is backed up.
            fileSize: undefined,
            favorite: metadata.isFavorite,
            archived: false,
            deleted: false,
            backupState: "local-only",
            source: "device",
          });
        }
        // `rows` is the live accumulator, not a snapshot to copy: re-copying it
        // per page is quadratic across a fifty-page walk.
        this.#deviceRows = rows;
        if (offset === 0) {
          this.#deviceLoading = false;
          this.recompute();
        } else this.scheduleRecompute();
        // A short page is the last page: the query has no cursor to run out of.
        if (page.length < pageSize) {
          this.recompute();
          return;
        }
        return loadPage(offset + page.length, 1_000);
      };
      await loadPage(0, 250);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error = error instanceof Error ? error.message : String(error);
      this.#deviceLoading = false;
      this.recompute();
    }
  }

  /** One open handle per gateway base for as long as Photos is on screen. */
  private uploadQueue(base: string): UploadQueue | undefined {
    if (this.#queue && this.#queueBase === base) return this.#queue;
    this.closeUploadQueue();
    try {
      this.#queue = UploadQueue.open({
        gatewayBaseUrl: base,
        headers: authHeader,
      });
    } catch {
      // Opening can fail while storage is unavailable. Skipping this tick and
      // retrying on the next one is the recovery; the durable queue is intact.
      return undefined;
    }
    this.#queueBase = base;
    return this.#queue;
  }

  private closeUploadQueue(): void {
    this.#queue?.close();
    this.#queue = undefined;
    this.#queueBase = undefined;
  }

  /** Collapse the walk's page-by-page recomputes into one per quiet window. */
  private scheduleRecompute(): void {
    if (this.#recomputeTimer) return;
    this.#recomputeTimer = setTimeout(() => {
      this.#recomputeTimer = undefined;
      this.recompute();
    }, WALK_RECOMPUTE_DEBOUNCE_MS);
  }

  private recompute(): void {
    if (this.#recomputeTimer) {
      clearTimeout(this.#recomputeTimer);
      this.#recomputeTimer = undefined;
    }
    const base = this.#gatewayBase;
    const deviceWithQueue = this.#deviceRows.map((asset) => {
      const upload = this.#uploadByUri.get(asset.originalUri);
      if (!upload) return asset;
      const backupState: BackupState =
        upload.state === "settled"
          ? "backed-up"
          : upload.state === "uploading" || upload.state === "completing"
            ? "uploading"
            : "queued";
      return {
        ...asset,
        sha256: upload.sha256,
        backupState,
        verifiedCasAck:
          upload.state === "settled" && upload.receipt?.casAck === "replicated",
      };
    });

    const contentById = new Map(
      this.#contentRows.map((row) => [value<string>(row, "content_id"), row])
    );
    const derivativesByContent = new Map<string, ReplicaRow[]>();
    for (const row of this.#derivativeRows) {
      const id = value<string>(row, "content_id");
      if (!id) continue;
      derivativesByContent.set(id, [
        ...(derivativesByContent.get(id) ?? []),
        row,
      ]);
    }
    const phashByAsset = new Map(
      this.#phashRows.map((row) => [
        value<string>(row, "asset_id"),
        value<string>(row, "phash"),
      ])
    );
    const remote = this.#assetRows.flatMap<PhotoAsset>((asset) => {
      const contentId = value<string>(asset, "content_id");
      const assetId = value<string>(asset, "asset_id");
      const item = contentId ? contentById.get(contentId) : undefined;
      const sha = item ? value<string>(item, "sha256") : undefined;
      if (!contentId || !assetId || !sha) return [];
      const rungs = derivativesByContent.get(contentId) ?? [];
      const thumbhash = rungs.find(
        (row) => value(row, "variant") === "thumbhash"
      );
      const kind = (value<string>(asset, "kind") ??
        "photo") as PhotoAsset["kind"];
      const scopeId =
        value<string>(asset, "__centraidScopeId") ??
        value<string>(item!, "__centraidScopeId") ??
        "";
      const original = base
        ? `${base}/centraid/_gateway/blobs/${encodeURIComponent(
            scopeId
          )}/${encodeURIComponent(contentId)}`
        : "";
      const thumb = base
        ? `${original}?variant=${kind === "video" ? "poster" : "thumb"}`
        : original;
      const capturedAt =
        value<string>(asset, "captured_at") ??
        value<string>(item!, "created_at");
      const exifJson = value<string>(asset, "exif_json");
      return [
        {
          id: `replica:${assetId}`,
          assetId,
          contentId,
          placeId: value<string>(asset, "place_id"),
          captureGroupId: value<string>(asset, "capture_group_id"),
          uri: pinnedThumbnailUri(scopeId, contentId) ?? thumb,
          previewUri: base ? `${original}?variant=preview` : original,
          originalUri: original,
          filename: value<string>(item!, "title"),
          sha256: sha,
          phash: phashByAsset.get(assetId),
          thumbhash: thumbhash
            ? value<string>(thumbhash, "text_content")
            : undefined,
          capturedAt: capturedAt ?? new Date(0).toISOString(),
          tzOffsetMin: value<number>(asset, "tz_offset_min"),
          kind,
          width: value<number>(asset, "width"),
          height: value<number>(asset, "height"),
          durationS: value<number>(asset, "duration_s"),
          fileSize: value<number>(item!, "byte_size"),
          exif: parseExif(exifJson),
          favorite: value<number>(asset, "favorite") === 1,
          archived: Boolean(value<string>(asset, "archived_at")),
          deleted: Boolean(value<string>(asset, "deleted_at")),
          purgeAt:
            value<string>(asset, "purge_at") ??
            value<string>(item!, "purge_at"),
          backupState: "remote-only",
          source: "replica",
          sourceVaultId: scopeId,
          scopeIds:
            value<string[]>(asset, "__centraidScopeIds") ??
            value<string[]>(item!, "__centraidScopeIds") ??
            [],
          scopeLabels: [
            ...(value<string[]>(item!, "__centraidScopeLabels") ?? [
              value<string>(asset, "__centraidScopeLabel") ??
                value<string>(item!, "__centraidScopeLabel") ??
                "Vault",
            ]),
          ],
          writableScopeIds:
            value<string[]>(asset, "__centraidWritableScopeIds") ??
            value<string[]>(item!, "__centraidWritableScopeIds") ??
            [],
          canWrite:
            value<boolean>(asset, "__centraidCanWrite") ??
            value<boolean>(item!, "__centraidCanWrite") ??
            false,
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
    this.stopUploadPoll();
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.closeUploadQueue();
    this.#uploadsInFlight = false;
    if (this.#recomputeTimer) clearTimeout(this.#recomputeTimer);
    this.#recomputeTimer = undefined;
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
    this.#uploadSignature = "";
    this.#error = undefined;
    this.#snapshot = EMPTY;
  }
}

export const photoTimelineEngine = new PhotoTimelineEngine();
