import { rmSync } from 'node:fs';
import type { BlobCache } from './cache.js';
import type { RemoteTier } from './custody-types.js';
import type { LocalBlobStore } from './local.js';
import { drainOutboxRow } from './outbox-drain.js';
import { cleanupOrphanedMultipartUploads } from './orphan-multipart.js';
import type { BlobTransferState, OutboxRow } from './transfer-state.js';

const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ORPHAN_SWEEP_RETRY_MS = 60 * 1000;

export interface BlobOutboxRunnerOptions {
  state: BlobTransferState;
  local: LocalBlobStore;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  onStatus(): void;
  intervalMs?: number;
}

/** Continuous single-flight custody drain with bounded per-blob workers (#414). */
export class BlobOutboxRunner {
  private readonly timer: NodeJS.Timeout;
  private flight: Promise<void> | null = null;
  private closed = false;
  private nextOrphanSweepAt = 0;

  constructor(private readonly options: BlobOutboxRunnerOptions) {
    this.timer = setInterval(() => this.kick(), options.intervalMs ?? 1_000);
    this.timer.unref();
  }

  kick(): void {
    if (this.closed || this.flight) return;
    this.flight = this.drainDue()
      .catch(() => undefined)
      .finally(() => {
        this.flight = null;
      });
  }

  private deps() {
    return {
      state: this.options.state,
      local: this.options.local,
      cache: this.options.cache,
      remote: this.options.remote,
      onReplicated: () => this.options.onStatus(),
    };
  }

  async drainDue(): Promise<void> {
    await this.cleanupExpiredSessions();
    await this.cleanupOrphanedMultipart();
    const rows = this.options.state.dueOutbox();
    let next = 0;
    const drainNext = async (): Promise<void> => {
      for (;;) {
        const row = rows[next];
        next += 1;
        if (!row) return;
        await this.drainRow(row);
      }
    };
    const workers = Math.min(rows.length, Math.max(1, this.options.cache.replicationConcurrency));
    await Promise.all(Array.from({ length: workers }, () => drainNext()));
  }

  private async drainRow(row: OutboxRow): Promise<void> {
    try {
      await drainOutboxRow(this.deps(), row);
    } catch (error) {
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempt_count, 6));
      this.options.state.failOutbox(
        row.sha256,
        error instanceof Error ? error.message : String(error),
        new Date(Date.now() + backoffMs).toISOString(),
      );
      this.options.onStatus();
    }
  }

  async drainSha(sha256: string): Promise<void> {
    const row = this.options.state.outbox(sha256);
    if (!row) return;
    try {
      await drainOutboxRow(this.deps(), row);
    } catch (error) {
      this.options.state.failOutbox(
        sha256,
        error instanceof Error ? error.message : String(error),
        new Date(Date.now() + 1_000).toISOString(),
      );
      throw error;
    }
  }

  private async cleanupExpiredSessions(): Promise<void> {
    for (const row of this.options.state.expiredSessions()) {
      if (row.temp_path) rmSync(row.temp_path, { force: true });
      const transfer = this.options.remote()?.transfer;
      if (row.remote_temp_id && row.remote_upload_id) {
        await transfer
          ?.abortTemporaryUpload(row.remote_temp_id, row.remote_upload_id)
          .catch(() => undefined);
      }
      if (row.remote_temp_id) {
        await transfer?.deleteTemporary(row.remote_temp_id).catch(() => undefined);
      }
      this.options.state.deleteSession(row.session_id);
    }
  }

  private async cleanupOrphanedMultipart(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs < this.nextOrphanSweepAt) return;
    const transfer = this.options.remote()?.transfer;
    if (!transfer?.listTemporaryUploads) {
      this.nextOrphanSweepAt = nowMs + ORPHAN_SWEEP_RETRY_MS;
      return;
    }
    try {
      await cleanupOrphanedMultipartUploads({ state: this.options.state, transfer, nowMs });
      this.nextOrphanSweepAt = nowMs + ORPHAN_SWEEP_INTERVAL_MS;
    } catch {
      this.nextOrphanSweepAt = nowMs + ORPHAN_SWEEP_RETRY_MS;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flight?.catch(() => undefined);
  }
}
