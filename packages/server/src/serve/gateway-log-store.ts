import fs from "node:fs";
import path from "node:path";

import type { RuntimeLogger } from "@centraid/server/engine";
import { isDiskFullError, sharedDiskFullTracker } from "@centraid/vault";
import type { DiskFullTracker } from "@centraid/vault";

export type GatewayLogLevel = "info" | "warn" | "error";

export interface GatewayLogEntry {
  seq: number;
  ts: number;
  level: GatewayLogLevel;
  message: string;
}

export type GatewayLogListener = (
  entry: GatewayLogEntry,
  serialized: string
) => void;

export interface GatewayLogStoreOptions {
  dir?: string;
  diskFullTracker?: DiskFullTracker;
}

const DISK_FULL_RETRY_MS = 30_000;
const DEFAULT_CAPACITY = 2000;
const ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;
const CURRENT_FILE_NAME = "gateway.jsonl";

function rotatedFileName(n: number): string {
  return `gateway.${n}.jsonl`;
}

export class GatewayLogStore {
  private readonly capacity: number;
  private readonly entries: GatewayLogEntry[] = [];
  private readonly listeners = new Set<GatewayLogListener>();
  private nextSeq = 1;
  private readonly dir: string | undefined;
  private readonly currentFile: string | undefined;
  private droppedWrites = 0;
  private readonly diskFullTracker: DiskFullTracker;
  private diskFullUntil: number | null = null;

  constructor(
    capacity: number = DEFAULT_CAPACITY,
    options: GatewayLogStoreOptions = {}
  ) {
    this.capacity = Math.max(1, capacity);
    this.dir = options.dir;
    this.diskFullTracker = options.diskFullTracker ?? sharedDiskFullTracker;
    if (this.dir) {
      this.currentFile = path.join(this.dir, CURRENT_FILE_NAME);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        // Intentionally empty.
      }
      this.loadTail();
    }
  }

  append(level: GatewayLogLevel, message: string): GatewayLogEntry {
    const entry: GatewayLogEntry = {
      seq: this.nextSeq++,
      ts: Date.now(),
      level,
      message,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    const serialized = JSON.stringify(entry);
    this.persist(serialized);
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(entry, serialized);
      } catch {
        // Intentionally empty.
      }
    }
    return entry;
  }

  snapshot(afterSeq = 0): GatewayLogEntry[] {
    if (afterSeq <= 0) return [...this.entries];
    return this.entries.filter((e) => e.seq > afterSeq);
  }

  subscribe(fn: GatewayLogListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  droppedWriteCount(): number {
    return this.droppedWrites;
  }

  diskFullSuspended(): boolean {
    return this.diskFullUntil !== null && Date.now() < this.diskFullUntil;
  }

  wrap(inner: RuntimeLogger): RuntimeLogger {
    return {
      info: (m) => {
        this.append("info", m);
        inner.info(m);
      },
      warn: (m) => {
        this.append("warn", m);
        inner.warn(m);
      },
      error: (m) => {
        this.append("error", m);
        inner.error(m);
      },
    };
  }

  private persist(serialized: string): void {
    if (!this.dir || !this.currentFile) return;
    if (this.diskFullUntil !== null && Date.now() < this.diskFullUntil) {
      this.droppedWrites += 1;
      return;
    }
    try {
      fs.appendFileSync(this.currentFile, `${serialized}\n`);
      this.diskFullUntil = null;
      this.rotateIfNeeded();
    } catch (error) {
      this.droppedWrites += 1;
      if (isDiskFullError(error)) {
        this.diskFullUntil = Date.now() + DISK_FULL_RETRY_MS;
        this.diskFullTracker.report(error, "gateway log persistence");
      }
    }
  }

  private rotateIfNeeded(): void {
    if (!this.dir || !this.currentFile) return;
    let size: number;
    try {
      size = fs.statSync(this.currentFile).size;
    } catch {
      return;
    }
    if (size < ROTATE_BYTES) return;
    try {
      for (let n = MAX_ROTATED_FILES; n >= 2; n--) {
        const dest = path.join(this.dir, rotatedFileName(n));
        const src = path.join(this.dir, rotatedFileName(n - 1));
        try {
          fs.rmSync(dest, { force: true });
        } catch {
          // Intentionally empty.
        }
        try {
          fs.renameSync(src, dest);
        } catch {
          // Intentionally empty.
        }
      }
      fs.renameSync(this.currentFile, path.join(this.dir, rotatedFileName(1)));
    } catch {
      this.droppedWrites += 1;
    }
  }

  private loadTail(): void {
    if (!this.dir || !this.currentFile) return;
    const files = [
      ...Array.from({ length: MAX_ROTATED_FILES }, (_, i) =>
        path.join(this.dir as string, rotatedFileName(MAX_ROTATED_FILES - i))
      ),
      this.currentFile,
    ];
    const lines: string[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        for (const line of raw.split("\n")) {
          if (line.length > 0) lines.push(line);
        }
      } catch {
        // Intentionally empty.
      }
    }
    const tail = lines.slice(-this.capacity);
    let maxSeq = 0;
    for (const line of tail) {
      const entry = parseLogLine(line);
      if (!entry) continue;
      this.entries.push(entry);
      if (entry.seq > maxSeq) maxSeq = entry.seq;
    }
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    if (maxSeq > 0) this.nextSeq = maxSeq + 1;
  }
}

function parseLogLine(line: string): GatewayLogEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<GatewayLogEntry>;
    if (
      typeof parsed.seq === "number" &&
      typeof parsed.ts === "number" &&
      typeof parsed.message === "string" &&
      (parsed.level === "info" ||
        parsed.level === "warn" ||
        parsed.level === "error")
    ) {
      return {
        seq: parsed.seq,
        ts: parsed.ts,
        level: parsed.level,
        message: parsed.message,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
