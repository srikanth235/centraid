// One shared timeline instance for the whole Photos stack (#419, finding 5):
// a process-singleton engine that reads the replica, walks the camera roll,
// folds the upload queue in, and publishes an immutable snapshot every screen
// subscribes to via `useSyncExternalStore`. Driven imperatively, so it
// survives screen mount/unmount; the hook API is unchanged.

import * as MediaLibrary from "expo-media-library";
import { AppState } from "react-native";

import type { Page, PageCursor } from "@centraid/core/page";

import { coalesceWork } from "../../lib/coalesce";
import { authHeader } from "../../lib/gateway";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import type { NativeSeatPagePort } from "../../lib/replica/seat-port";
import { pinnedThumbnailUri } from "../../lib/replica/thumbnail-pack";
import { UploadQueue } from "../../lib/upload/native-queue";
import { onUploadQueueChanged } from "../../lib/upload/upload-notifications";
import { capturedAtIso, durationSeconds } from "./device-media";
import { photoLibraryQuery, starredConceptQuery } from "./library-page";
import type { PhotoLibraryRow } from "./library-page";
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

/** Debounce merged-timeline recomputes during the device walk; page one paints immediately. */
const WALK_RECOMPUTE_DEBOUNCE_MS = 250;

/**
 * Invalidation burst window, mirroring the kit's `useReplicaQuery`: long
 * enough to swallow one delta batch, short enough that a change made on
 * another device still feels immediate.
 */
const REPLICA_INVALIDATION_WINDOW_MS = 120;

/** How many rows one page of the library walk asks for. */
const LIBRARY_PAGE = 500;
/** A walk is bounded; a library past this many pages is not a real library. */
const MAX_LIBRARY_PAGES = 400;

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
  /**
   * THE SEAT IS WHAT THE LIBRARY IS READ FROM (#996, W5-D1). Separate from the
   * session because it arrives BEHIND the mount — the first bootstrap is the
   * whole vault file — and absent means "no copy yet", which draws the device
   * half of the timeline and nothing else.
   */
  #seat?: NativeSeatPagePort;
  #gatewayBase?: string;
  #generation = 0;
  #unsubscribe?: () => void;
  #unsubscribeUploads?: () => void;
  #appStateSub?: { remove: () => void };
  #queue?: UploadQueue;
  #queueBase?: string;
  #recomputeTimer?: ReturnType<typeof setTimeout>;
  #reading = false;
  #readAgain = false;

  /** The library, one joined row per asset (`library-page.ts`). */
  #libraryRows: PhotoLibraryRow[] = [];
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
      // THE QUEUE ANNOUNCES ITSELF (#996 wave 3): `enqueue` and `drain` fire
      // `notifyUploadQueueChanged`, so the badges flip when a row actually
      // moves rather than up to four seconds later.
      this.#unsubscribeUploads ??= onUploadQueueChanged(() =>
        this.refreshUploads()
      );
      // Foregrounding stays a trigger, and it is not a poll in disguise: the
      // background pass drains in its own task and its notices do not reach a
      // torn-down listener, so the first thing a returning screen owes the
      // member is one re-read.
      this.#appStateSub ??= AppState.addEventListener("change", (state) => {
        if (state === "active") this.refreshUploads();
      });
    }
    return () => {
      this.#refs -= 1;
      if (this.#refs <= 0) this.teardown();
    };
  }

  setSession(
    session: MobileReplicaSession | undefined,
    gatewayBase: string | undefined,
    seat?: NativeSeatPagePort
  ): void {
    const sessionChanged = session !== this.#session;
    const baseChanged = gatewayBase !== this.#gatewayBase;
    // A SEAT THAT ARRIVES IS A REASON TO READ AGAIN. It lands behind the mount,
    // so the first pass after `setSession` usually has none; without this the
    // library would stay empty until some unrelated invalidation fired.
    const seatChanged = seat !== this.#seat;
    this.#session = session;
    this.#gatewayBase = gatewayBase;
    this.#seat = seat;
    if (!session) return;
    if (sessionChanged) {
      this.#generation += 1;
      this.#unsubscribe?.();
      this.#replicaLoading = true;
      // A bootstrap emits one invalidation per committed page and the mounted
      // session fans each one out per scope, so this listener fires in bursts
      // of hundreds. Collapse a burst into one pass; the first read still runs
      // straight away, because a cold Photos screen has nothing to show.
      const coalesced = coalesceWork(
        () => this.readReplica(),
        REPLICA_INVALIDATION_WINDOW_MS
      );
      const unsubscribe = session.subscribe("photos", coalesced.signal);
      this.#unsubscribe = () => {
        coalesced.cancel();
        unsubscribe();
      };
      void this.readReplica();
    }
    if (seatChanged && !sessionChanged && session) void this.readReplica();
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

  /**
   * ONE replica pass at a time. Each pass is four full-projection reads that
   * hold SHARED locks on every mounted vault, so stacking them against the
   * writer that is still bootstrapping is the worst thing this engine can do.
   * An invalidation that lands mid-pass marks the result stale and buys
   * exactly one more pass afterwards, however many arrived.
   */
  private async readReplica(): Promise<void> {
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    this.#reading = true;
    try {
      await this.readReplicaPass();
    } finally {
      this.#reading = false;
    }
    if (!this.#readAgain) return;
    this.#readAgain = false;
    return this.readReplica();
  }

  /**
   * ONE STATEMENT, WALKED (#996, R8 and W5-D1).
   *
   * This was seven whole-table reads at `limit: 100_000` through the
   * declarative plane, joined afterwards by five JavaScript `Map`s. The join is
   * SQLite's, and it has the indexes for it. What is left here is the walk and
   * the generation check.
   *
   * The seat is what answers it. A phone whose copy has not arrived has no
   * library to show and says so through the same empty snapshot it always did —
   * the device half of the timeline is unaffected, which is the whole reason
   * the two halves are merged rather than one being the other's fallback.
   */
  private async readReplicaPass(): Promise<void> {
    const seat = this.#seat;
    if (!seat) {
      this.#replicaLoading = false;
      this.recompute();
      return;
    }
    const generation = this.#generation;
    try {
      const concept = (
        await seat.page<{ concept_id: string }>({
          query: starredConceptQuery(),
          limit: 1,
        })
      ).rows[0]?.concept_id;
      const query = photoLibraryQuery(concept);
      const rows: PhotoLibraryRow[] = [];
      let after: PageCursor | undefined = undefined;
      for (let page = 0; page < MAX_LIBRARY_PAGES; page += 1) {
        // Sequential by definition: the next page's cursor is this page's
        // answer, and a concurrent walk would read the same window twice.
        // oxlint-disable-next-line no-await-in-loop
        const answer: Page<PhotoLibraryRow> = await seat.page<PhotoLibraryRow>({
          query,
          limit: LIBRARY_PAGE,
          ...(after ? { after } : {}),
        });
        if (generation !== this.#generation) return;
        rows.push(...answer.rows);
        if (!answer.next) break;
        after = answer.next;
      }
      this.#libraryRows = rows;
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

    const scope = this.#session?.scope?.();
    const remote = this.#libraryRows.map<PhotoAsset>((row) => {
      const kind = (row.kind ?? "photo") as PhotoAsset["kind"];
      const scopeId = scope?.vaultId ?? "";
      const original = base
        ? `${base}/centraid/_gateway/blobs/${encodeURIComponent(
            scopeId
          )}/${encodeURIComponent(row.content_id)}`
        : "";
      const thumb = base
        ? `${original}?variant=${kind === "video" ? "poster" : "thumb"}`
        : original;
      return {
        id: `replica:${row.asset_id}`,
        assetId: row.asset_id,
        contentId: row.content_id,
        placeId: row.place_id ?? undefined,
        captureGroupId: row.capture_group_id ?? undefined,
        uri: pinnedThumbnailUri(scopeId, row.content_id) ?? thumb,
        previewUri: base ? `${original}?variant=preview` : original,
        originalUri: original,
        // THE AUTHORED TITLE IS THE ASSET'S (#996, R20(b)). It was read off
        // `core.content_item`, which has carried no `title` since the byte row
        // lost its interpretation — so this was `undefined` for every photo in
        // the library.
        filename: row.title ?? undefined,
        sha256: row.sha256,
        phash: row.phash ?? undefined,
        thumbhash: row.thumbhash ?? undefined,
        capturedAt: row.captured_key || new Date(0).toISOString(),
        tzOffsetMin: row.tz_offset_min ?? undefined,
        kind,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        durationS: row.duration_s ?? undefined,
        fileSize: row.byte_size,
        exif: parseExif(row.exif_json ?? undefined),
        favorite: row.starred === 1,
        archived: Boolean(row.archived_at),
        deleted: Boolean(row.deleted_at),
        purgeAt: row.purge_at ?? undefined,
        backupState: "remote-only",
        source: "replica",
        sourceVaultId: scopeId,
        // ONE VAULT, ONE SEAT (#996, R12). The scope columns these fields came
        // from were the multi-vault reader's per-row provenance; a seat opens
        // one file, so the answer is the session's own scope for every row.
        scopeIds: scopeId ? [scopeId] : [],
        scopeLabels: [scope?.label ?? "Vault"],
        writableScopeIds: scope?.canWrite && scopeId ? [scopeId] : [],
        canWrite: scope?.canWrite ?? false,
      };
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
    this.#unsubscribeUploads?.();
    this.#unsubscribeUploads = undefined;
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.closeUploadQueue();
    if (this.#recomputeTimer) clearTimeout(this.#recomputeTimer);
    this.#recomputeTimer = undefined;
    this.#generation += 1;
    this.#session = undefined;
    this.#gatewayBase = undefined;
    this.#deviceStarted = false;
    this.#deviceLoading = true;
    this.#replicaLoading = true;
    // An in-flight pass is already stale by generation; drop its follow-up too.
    this.#readAgain = false;
    this.#libraryRows = [];
    this.#seat = undefined;
    this.#deviceRows = [];
    this.#uploadByUri = new Map();
    this.#uploadSignature = "";
    this.#error = undefined;
    this.#snapshot = EMPTY;
  }
}

export const photoTimelineEngine = new PhotoTimelineEngine();
