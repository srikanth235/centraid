/*
 * The trace store: the ONE place a #927 trace record is written, and the only
 * place one is read from.
 *
 * SOVEREIGN BY LOCATION. Records go to `<vaultDir>/diagnostics/traces.jsonl`,
 * inside the directory the erase ceremony already removes whole
 * (`VaultRegistry.delete` → `rmSync(plane.dir)`), so purge-with-vault is a
 * property of where the file is and not of a sweeper anyone has to remember to
 * run. No route serves this file, no bundle collects it, no peer plane
 * forwards it. See docs/logs.md § "Traces and work counters (#927)".
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { validateTraceRecord } from "@centraid/core/protocol";
import type { TraceRecord } from "@centraid/core/protocol";

/** The diagnostics slot inside a vault directory; purged with the vault. */
export const TRACE_DIR_NAME = "diagnostics";
export const TRACE_FILE_NAME = "traces.jsonl";
/** One rotation only: the store is a developer convenience, not evidence. */
const ROTATE_BYTES = 2 * 1024 * 1024;

export function traceFileFor(vaultDir: string): string {
  return path.join(vaultDir, TRACE_DIR_NAME, TRACE_FILE_NAME);
}

/** What an emitter needs from a store; the tracer never reads. */
export interface TraceSink {
  append: (record: TraceRecord) => void;
}

/** Append-only JSONL under the vault's diagnostics dir. */
export class TraceStore {
  private readonly file: string;
  private failed = false;

  constructor(vaultDir: string) {
    this.file = traceFileFor(vaultDir);
  }

  /** Failures are swallowed: a diagnostics write must never fail a request. */
  append(record: TraceRecord): void {
    if (this.failed) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (statSync(this.file).size >= ROTATE_BYTES) {
          renameSync(this.file, `${this.file}.1`);
        }
      } catch {
        /* No file yet, or a racing rotation: append creates it. */
      }
      appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    } catch {
      // One failure disables the store for this process rather than retrying
      // per request on a full or read-only disk.
      this.failed = true;
    }
  }

  /** The last complete record, or undefined when nothing has been recorded. */
  last(): TraceRecord | undefined {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return undefined;
    }
    const lines = text.split("\n").filter((line) => line.length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return validateTraceRecord(JSON.parse(lines[index] as string));
      } catch {
        // A torn last line (the process died mid-append) is skipped, not fatal.
      }
    }
    return undefined;
  }

  /** Drop everything recorded so far; the developer command's `--clear`. */
  clear(): void {
    try {
      writeFileSync(this.file, "");
    } catch {
      /* Nothing recorded yet. */
    }
  }
}

/**
 * A sink bound to whichever vault is current when the FIRST record is written.
 * Lazy because `serve()` builds its handler chain before a vault is
 * necessarily mounted, and because the record must land inside the vault
 * directory to be purged with it. A function rather than a class: it holds one
 * piece of state and owes the caller one method.
 */
export function lazyVaultTraceSink(
  vaultDir: () => string | undefined
): TraceSink {
  let store: TraceStore | undefined;
  return {
    append: (record) => {
      if (!store) {
        const dir = vaultDir();
        if (dir === undefined) return;
        store = new TraceStore(dir);
      }
      store.append(record);
    },
  };
}
