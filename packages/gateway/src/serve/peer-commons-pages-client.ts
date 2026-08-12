/** Stream bounded Commons metadata pages into one verified record frame. */

import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { CommonsBootstrap, CommonsTombstone } from "@centraid/vault";

import { COMMONS_BOOTSTRAP_PAGE_BYTES } from "../routes/peer-commons-pages.js";

export interface CommonsBootstrapBody {
  state?: string;
  wire?: CommonsBootstrap;
  tombstone?: CommonsTombstone;
  currentSequence?: number;
  headHash?: string;
}

interface BootstrapPage {
  state?: string;
  frameId?: string;
  cursor?: number;
  nextCursor?: number | null;
  totalBytes?: number;
  bytes?: string;
}

interface FrameRecord {
  path?: string;
  value?: unknown;
}

function decode(
  page: BootstrapPage,
  frameId: string | undefined,
  cursor: number
):
  | {
      bytes: Buffer;
      frameId: string;
      nextCursor: number | null;
      total: number;
    }
  | undefined {
  if (
    page.state !== "bootstrap-page" ||
    typeof page.frameId !== "string" ||
    (frameId !== undefined && page.frameId !== frameId) ||
    page.cursor !== cursor ||
    (page.nextCursor !== null && typeof page.nextCursor !== "number") ||
    typeof page.totalBytes !== "number" ||
    !Number.isSafeInteger(page.totalBytes) ||
    page.totalBytes < 0 ||
    typeof page.bytes !== "string"
  )
    return undefined;
  const bytes = Buffer.from(page.bytes, "base64");
  if (bytes.length > COMMONS_BOOTSTRAP_PAGE_BYTES) return undefined;
  return {
    bytes,
    frameId: page.frameId,
    nextCursor: page.nextCursor,
    total: page.totalBytes,
  };
}

function emptyWire(
  header: Record<string, unknown>
): CommonsBootstrap | undefined {
  const closure = header["closure"];
  const control = header["control"];
  if (
    typeof header["grantId"] !== "string" ||
    typeof header["stewardVaultId"] !== "string" ||
    typeof header["memberVaultId"] !== "string" ||
    !Number.isSafeInteger(header["snapshotSequence"]) ||
    !Number.isSafeInteger(header["currentSequence"]) ||
    !closure ||
    typeof closure !== "object" ||
    !control ||
    typeof control !== "object" ||
    !header["checkpoint"] ||
    typeof header["checkpoint"] !== "object"
  )
    return undefined;
  const closureHeader = closure as Record<string, unknown>;
  const controlHeader = control as Record<string, unknown>;
  if (
    typeof closureHeader["formatVersion"] !== "number" ||
    typeof closureHeader["originVaultId"] !== "string" ||
    !controlHeader["grant"] ||
    typeof controlHeader["grant"] !== "object" ||
    !controlHeader["circle"] ||
    typeof controlHeader["circle"] !== "object"
  )
    return undefined;
  return {
    grantId: header["grantId"],
    stewardVaultId: header["stewardVaultId"],
    memberVaultId: header["memberVaultId"],
    snapshotSequence: header["snapshotSequence"] as number,
    currentSequence: header["currentSequence"] as number,
    checkpoint: header["checkpoint"] as CommonsBootstrap["checkpoint"],
    closure: {
      formatVersion: closureHeader[
        "formatVersion"
      ] as CommonsBootstrap["closure"]["formatVersion"],
      originVaultId: closureHeader["originVaultId"],
      items: [],
      rows: {
        contentItems: [],
        derivatives: [],
        mediaAssets: [],
        documents: [],
        docsFolders: [],
        collections: [],
        lockerItems: [],
        tallyGroups: [],
      },
      blobs: [],
    },
    control: {
      grant: controlHeader["grant"] as Record<string, unknown>,
      circle: controlHeader["circle"] as Record<string, unknown>,
      members: [],
      memberStates: [],
      parties: [],
      bindings: [],
      replay: [],
      receipts: [],
    },
    tail: [],
  };
}

function append(wire: CommonsBootstrap, record: FrameRecord): boolean {
  if (record.path === "closure.items") {
    wire.closure.items.push(
      record.value as CommonsBootstrap["closure"]["items"][number]
    );
    return true;
  }
  if (record.path === "closure.blobs") {
    wire.closure.blobs.push(
      record.value as CommonsBootstrap["closure"]["blobs"][number]
    );
    return true;
  }
  if (record.path === "tail") {
    (wire.tail as Record<string, unknown>[]).push(
      record.value as Record<string, unknown>
    );
    return true;
  }
  if (record.path?.startsWith("closure.rows.")) {
    const table = record.path.slice(
      "closure.rows.".length
    ) as keyof CommonsBootstrap["closure"]["rows"];
    const rows = wire.closure.rows[table];
    if (!rows) return false;
    (rows as unknown[]).push(record.value);
    return true;
  }
  if (record.path?.startsWith("control.")) {
    const field = record.path.slice(
      "control.".length
    ) as keyof CommonsBootstrap["control"];
    const rows = wire.control[field];
    if (!Array.isArray(rows)) return false;
    rows.push(record.value as Record<string, unknown>);
    return true;
  }
  return false;
}

async function parseFrame(
  file: string
): Promise<CommonsBootstrapBody | undefined> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let wire: CommonsBootstrap | undefined;
  try {
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line) as FrameRecord;
      if (!wire) {
        if (
          record.path !== "header" ||
          !record.value ||
          typeof record.value !== "object"
        )
          return undefined;
        wire = emptyWire(record.value as Record<string, unknown>);
        if (!wire) return undefined;
      } else if (!append(wire, record)) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
  }
  return wire ? { state: "bootstrap", wire } : undefined;
}

export async function collectCommonsBootstrapPages(input: {
  initial: { status: number; json: unknown };
  next: (
    frameId: string,
    cursor: number
  ) => Promise<{ status: number; json: unknown }>;
}): Promise<CommonsBootstrapBody | undefined> {
  const initialBody = input.initial.json as CommonsBootstrapBody;
  if (initialBody.state !== "bootstrap-page") return initialBody;
  const directory = mkdtempSync(path.join(tmpdir(), "centraid-commons-pull-"));
  const file = path.join(directory, "frame.ndjson");
  const descriptor = openSync(file, "wx", 0o600);
  let descriptorOpen = true;
  let expectedCursor = 0;
  let frameId: string | undefined;
  let total: number | undefined;
  let pageBody = initialBody as BootstrapPage;
  try {
    while (true) {
      const page = decode(pageBody, frameId, expectedCursor);
      if (!page || (total !== undefined && total !== page.total))
        return undefined;
      frameId = page.frameId;
      total = page.total;
      writeSync(descriptor, page.bytes);
      expectedCursor += page.bytes.length;
      if (page.nextCursor === null) break;
      if (page.nextCursor !== expectedCursor) return undefined;
      // oxlint-disable-next-line no-await-in-loop -- each cursor is authenticated by the preceding page
      const response = await input.next(frameId, page.nextCursor);
      if (response.status !== 200) return undefined;
      pageBody = response.json as BootstrapPage;
    }
    closeSync(descriptor);
    descriptorOpen = false;
    if (expectedCursor !== total) return undefined;
    return await parseFrame(file);
  } finally {
    if (descriptorOpen) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup remains best effort after a failed page.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
