// One shared timeline instance for the whole Photos stack (#419, finding 5):
// a process-singleton engine that reads the replica, walks the camera roll,
// folds the upload queue in, and publishes an immutable snapshot every screen
// subscribes to via `useSyncExternalStore`. Driven imperatively, so it
// survives screen mount/unmount; the hook API is unchanged.

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

/** Debounce merged-timeline recomputes during the device walk; page one paints immediately. */
const WALK_RECOMPUTE_DEBOUNCE_MS = 250;

const REPLICA_ENTITIES = [
  "media.asset",
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
   * Ref-counted screen mount; teardown only when the last Photos screen
   * leaves. Separate from `setSession` so a gateway-base change never bounces
   * the ref count and re-walks the library.
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
   * Flip queued → backed-up badges without a remount by polling the queue's
   * own SQLite database. Handle stays open while any screen is mounted, an
   * idle queue drops to a slow poll, nothing polls in the background.
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
    // A base change rewrites every remote URL without touching rows; re-derive, no re-walk.
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
        // Dead long-lived handle (storage, purge): drop it so next tick reopens.
        this.closeUploadQueue();
        return;
      }
    }
    const inFlight = [...next.values()].some(
      (entry) => entry.state !== "settled"
    );
    if (inFlight !== this.#uploadsInFlight) {
      this.#uploadsInFlight = inFlight;
      // Poll interval derives from this flag; re-arm at the new rate.
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
      // Small first page paints the grid fast; bigger bites after.
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
          // ONE native round-trip per page: `exe()`'s per-field getters cost
          // seven crossings per photo (~350k across a 50k library, not ~50).
          .exeForMetadata();
        if (generation !== this.#generation) return;
        for (const metadata of page) {
          // The media-store id IS the addressable uri (ph://…, content://…)
          // and renders directly in expo-image; full bytes resolve per asset
          // on demand via `openDeviceOriginal`.
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
            // Not worth a per-photo round-trip; replica row carries it once backed up.
            fileSize: undefined,
            favorite: metadata.isFavorite,
            archived: false,
            deleted: false,
            backupState: "local-only",
            source: "device",
          });
        }
        // Live accumulator, not a copy: per-page copying is quadratic over ~50 pages.
        this.#deviceRows = rows;
        if (offset === 0) {
          this.#deviceLoading = false;
          this.recompute();
        } else this.scheduleRecompute();
        // Short page = last page; the query has no cursor to run out of.
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

  /** One open handle per gateway base while Photos is mounted. */
  private uploadQueue(base: string): UploadQueue | undefined {
    if (this.#queue && this.#queueBase === base) return this.#queue;
    this.closeUploadQueue();
    try {
      this.#queue = UploadQueue.open({
        gatewayBaseUrl: base,
        headers: authHeader,
      });
    } catch {
      // Storage unavailable: skip this tick; the durable queue is intact.
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
