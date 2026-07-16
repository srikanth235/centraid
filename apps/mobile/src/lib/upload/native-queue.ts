// Device assembly of the upload queue (#419 M0.4).
//
// Native-module imports live here and in `expo-native.ts` only; the queue,
// sealer and drainer take every one of these by injection so the vitest rig
// can exercise them (the M0.2 lesson).

import { OpSqliteDriver } from '../replica/op-sqlite-driver';
import { webCryptoUploadCrypto, type UploadCrypto } from './crypto';
import { enqueueLocalFile, type EnqueueInput } from './enqueue';
import { expoFileSource, expoPartPutter } from './expo-native';
import { httpDirectTransferClient } from './gateway-client';
import {
  UploadQueueStore,
  type NewUploadFollowup,
  type UploadFollowupFactory,
  type UploadFollowup,
  type UploadItem,
} from './store';
import { UploadDrainer, type DrainSummary, type UploadPolicy } from './uploader';
import { createNativeDigest } from './native-digest';

/**
 * The queue's own database, deliberately NOT the replica's — see the header of
 * `store.ts` for why. op-sqlite resolves a bare name under the app's documents
 * directory, which is backed up and survives app updates.
 */
const UPLOAD_DB_NAME = 'centraid-uploads.db';

export interface UploadQueueOptions {
  gatewayBaseUrl: string;
  /** Extra headers for gateway calls (e.g. Authorization in manual dev mode). */
  headers?: () => Record<string, string>;
  policy?: UploadPolicy;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Overridable for tests; defaults to the ambient WebCrypto. */
  crypto?: UploadCrypto;
}

export class UploadQueue {
  private constructor(
    private readonly store: UploadQueueStore,
    private readonly drainer: UploadDrainer,
    private readonly deps: { newId: () => string },
  ) {}

  static open(options: UploadQueueOptions): UploadQueue {
    const store = UploadQueueStore.create(OpSqliteDriver.open({ name: UPLOAD_DB_NAME }));
    const scope = { gatewayBaseUrl: options.gatewayBaseUrl };
    const drainer = new UploadDrainer({
      store,
      client: httpDirectTransferClient({
        gatewayBaseUrl: options.gatewayBaseUrl,
        ...(options.headers ? { headers: options.headers } : {}),
      }),
      crypto: options.crypto ?? webCryptoUploadCrypto(),
      openFile: expoFileSource,
      putPart: expoPartPutter(scope),
      gatewayBaseUrl: options.gatewayBaseUrl,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.onProgress
        ? { onProgress: ({ completed, total }) => options.onProgress?.({ completed, total }) }
        : {}),
    });
    return new UploadQueue(store, drainer, {
      newId: () => `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
  }

  /** Address the bytes and durably queue them. Idempotent by content sha. */
  async enqueue(input: EnqueueInput, makeFollowup?: UploadFollowupFactory): Promise<UploadItem> {
    return enqueueLocalFile(
      {
        store: this.store,
        openFile: expoFileSource,
        newId: this.deps.newId,
        createDigest: createNativeDigest,
      },
      input,
      makeFollowup,
    );
  }

  /**
   * One resumable pass. Safe to call at any time from any lifecycle: recovery,
   * foreground reconciliation and a foreground-service drain are all just this.
   * When Android 15 stops a `dataSync` service at its 6h cap, the next call
   * resumes from the queue rather than restarting the work.
   */
  async drain(): Promise<DrainSummary> {
    return this.drainer.drainOnce();
  }

  pending(): UploadItem[] {
    return this.store.pending();
  }

  all(): UploadItem[] {
    return this.store.all();
  }

  enqueueFollowup(followup: NewUploadFollowup): UploadFollowup {
    return this.store.enqueueFollowup(followup);
  }

  pendingFollowups(): UploadFollowup[] {
    return this.store.pendingFollowups();
  }

  clearFollowup(followupId: number): void {
    this.store.clearFollowup(followupId);
  }

  close(): void {
    this.store.close();
  }
}
