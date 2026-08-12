/** Bounded, resumable transport pages for signed Commons bootstrap records. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommonsBootstrap } from "@centraid/vault";

import { sendJson } from "./route-helpers.js";

export const COMMONS_BOOTSTRAP_PAGE_BYTES = 256 * 1024;

const FRAME_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_FRAMES = 4;

interface CachedFrame {
  file: string;
  directory: string;
  size: number;
  expiresAt: number;
  grantId: string;
  memberVaultId: string;
  stewardVaultId: string;
}

export interface CommonsBootstrapPage {
  state: "bootstrap-page";
  frameId: string;
  cursor: number;
  nextCursor: number | null;
  totalBytes: number;
  bytes: string;
}

interface FrameRecord {
  path: string;
  value: unknown;
}

const frames = new Map<string, CachedFrame>();
let cachedBytes = 0;

function remove(frameId: string): void {
  const held = frames.get(frameId);
  if (!held) return;
  frames.delete(frameId);
  cachedBytes -= held.size;
  rmSync(held.directory, { recursive: true, force: true });
}

function prune(now: number): void {
  for (const [frameId, frame] of frames)
    if (frame.expiresAt <= now) remove(frameId);
}

function spool(wire: CommonsBootstrap): {
  file: string;
  directory: string;
  size: number;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "centraid-commons-frame-"));
  const file = path.join(directory, "frame.ndjson");
  const descriptor = openSync(file, "wx", 0o600);
  let size = 0;
  const write = (record: FrameRecord): void => {
    // One record at a time: peak serialization memory is bounded by the
    // largest row, never by the complete Commons frame.
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    size += bytes.length;
    if (size > MAX_CACHED_FRAME_BYTES)
      throw new Error("commons bootstrap frame exceeds the bounded cache");
    writeSync(descriptor, bytes);
  };
  try {
    write({
      path: "header",
      value: {
        grantId: wire.grantId,
        stewardVaultId: wire.stewardVaultId,
        memberVaultId: wire.memberVaultId,
        snapshotSequence: wire.snapshotSequence,
        currentSequence: wire.currentSequence,
        checkpoint: wire.checkpoint,
        closure: {
          formatVersion: wire.closure.formatVersion,
          originVaultId: wire.closure.originVaultId,
        },
        control: {
          grant: wire.control.grant,
          circle: wire.control.circle,
        },
      },
    });
    for (const value of wire.closure.items)
      write({ path: "closure.items", value });
    for (const [table, rows] of Object.entries(wire.closure.rows))
      for (const value of rows) write({ path: `closure.rows.${table}`, value });
    for (const value of wire.closure.blobs)
      write({ path: "closure.blobs", value });
    for (const field of [
      "members",
      "memberStates",
      "parties",
      "bindings",
      "replay",
      "receipts",
    ] as const)
      for (const value of wire.control[field])
        write({ path: `control.${field}`, value });
    for (const value of wire.tail) write({ path: "tail", value });
    fsyncSync(descriptor);
    closeSync(descriptor);
    return { file, directory, size };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // A completed close needs no second close during error cleanup.
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function sendPage(
  res: ServerResponse,
  frameId: string,
  frame: CachedFrame,
  cursor: number
): true {
  if (cursor > frame.size) {
    remove(frameId);
    return sendJson(res, 404, { state: "not_found" });
  }
  const next = Math.min(cursor + COMMONS_BOOTSTRAP_PAGE_BYTES, frame.size);
  const bytes = Buffer.allocUnsafe(next - cursor);
  const descriptor = openSync(frame.file, "r");
  try {
    const read = readSync(descriptor, bytes, 0, bytes.length, cursor);
    if (read !== bytes.length) {
      remove(frameId);
      return sendJson(res, 404, { state: "not_found" });
    }
  } finally {
    closeSync(descriptor);
  }
  const nextCursor = next < frame.size ? next : null;
  const sent = sendJson(res, 200, {
    state: "bootstrap-page",
    frameId,
    cursor,
    nextCursor,
    totalBytes: frame.size,
    bytes: bytes.toString("base64"),
  } satisfies CommonsBootstrapPage);
  if (nextCursor === null) remove(frameId);
  return sent;
}

/** Spool records once, then serve bounded pages without a full JSON buffer. */
export function beginCommonsBootstrapPages(input: {
  res: ServerResponse;
  wire: CommonsBootstrap;
}): true {
  const now = Date.now();
  prune(now);
  let spooled: ReturnType<typeof spool>;
  try {
    spooled = spool(input.wire);
  } catch {
    return sendJson(input.res, 413, { state: "frame_too_large" });
  }
  while (
    frames.size >= MAX_CACHED_FRAMES ||
    cachedBytes + spooled.size > MAX_CACHED_FRAME_BYTES
  ) {
    const oldest = frames.keys().next().value as string | undefined;
    if (!oldest) break;
    remove(oldest);
  }
  const frameId = randomUUID();
  const frame: CachedFrame = {
    ...spooled,
    expiresAt: now + FRAME_TTL_MS,
    grantId: input.wire.grantId,
    memberVaultId: input.wire.memberVaultId,
    stewardVaultId: input.wire.stewardVaultId,
  };
  frames.set(frameId, frame);
  cachedBytes += frame.size;
  return sendPage(input.res, frameId, frame, 0);
}

/** Resume only the exact linked vault pair and grant that opened the frame. */
export function resumeCommonsBootstrapPages(input: {
  res: ServerResponse;
  frameId: string;
  cursor: number;
  grantId: string;
  memberVaultId: string;
  stewardVaultId: string;
}): true {
  prune(Date.now());
  const frame = frames.get(input.frameId);
  if (
    !frame ||
    frame.grantId !== input.grantId ||
    frame.memberVaultId !== input.memberVaultId ||
    frame.stewardVaultId !== input.stewardVaultId
  )
    return sendJson(input.res, 404, { state: "not_found" });
  return sendPage(input.res, input.frameId, frame, input.cursor);
}
