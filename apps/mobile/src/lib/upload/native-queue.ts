import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { OpSqliteDriver } from "../replica/op-sqlite-driver";
import type { PendingUploadGroup } from "../replica/storage-accounting";
import { webCryptoUploadCrypto } from "./crypto";
import type { UploadCrypto } from "./crypto";
import { enqueueLocalFile } from "./enqueue";
import type { EnqueueInput } from "./enqueue";
import { expoFileSource, expoPartPutter } from "./expo-native";
import { httpDirectTransferClient } from "./gateway-client";
import { createNativeDigest } from "./native-digest";
import { UploadQueueStore } from "./store";
import type {
  NewUploadFollowup,
  UploadFollowupFactory,
  UploadFollowup,
  UploadItem,
} from "./store";
import { UploadDrainer } from "./uploader";
import type { DrainSummary, UploadPolicy } from "./uploader";

export const UPLOAD_DB_NAME = "centraid-uploads.db";

export interface UploadQueueOptions {
  gatewayBaseUrl: string;
  headers?: () => Record<string, string>;
  policy?: UploadPolicy;
  onProgress?: (progress: { completed: number; total: number }) => void;
  crypto?: UploadCrypto;
}

export class UploadQueue {
  private constructor(
    private readonly store: UploadQueueStore,
    private readonly drainer: UploadDrainer,
    private readonly deps: { newId: () => string }
  ) {}

  static open(options: UploadQueueOptions): UploadQueue {
    const store = UploadQueueStore.create(
      OpSqliteDriver.open({
        name: UPLOAD_DB_NAME,
        ...(replicaStorageDirectory()
          ? { location: replicaStorageDirectory() }
          : {}),
      })
    );
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
        ? {
            onProgress: ({ completed, total }) =>
              options.onProgress?.({ completed, total }),
          }
        : {}),
    });
    return new UploadQueue(store, drainer, {
      newId: () =>
        `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
  }

  async enqueue(
    input: EnqueueInput,
    makeFollowup?: UploadFollowupFactory
  ): Promise<UploadItem> {
    return enqueueLocalFile(
      {
        store: this.store,
        openFile: expoFileSource,
        newId: this.deps.newId,
        createDigest: createNativeDigest,
      },
      input,
      makeFollowup
    );
  }

  async drain(): Promise<DrainSummary> {
    return this.drainer.drainOnce();
  }

  pending(): UploadItem[] {
    return this.store.pending();
  }

  pendingStorageGroups(): PendingUploadGroup[] {
    return this.store.pendingStorageGroups();
  }

  bySha(sha256: string): UploadItem | undefined {
    return this.store.bySha(sha256);
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

  hasFollowupForItem(itemId: string): boolean {
    return this.store.hasFollowupForItem(itemId);
  }

  clearFollowup(followupId: number): void {
    this.store.clearFollowup(followupId);
  }

  countFollowupAttempt(followupId: number): number {
    return this.store.countFollowupAttempt(followupId);
  }

  poisonFollowup(followupId: number, reason: string): void {
    this.store.poisonFollowup(followupId, reason);
  }

  poisonedFollowupCount(): number {
    return this.store.poisonedFollowupCount();
  }

  close(): void {
    this.store.close();
  }
}
