import { sniffMediaType } from "../blob/pipeline.js";
import { stageBlobBytes, mediaLocationPolicy } from "../blob/staging.js";
import type { VaultDb } from "../db.js";
import type { Identity } from "../gateway/types.js";
import { parseCsvRows, parseTransactionsCsv } from "./csv.js";
import { parseIcs } from "./ics.js";
import { parseMarkdownNote } from "./markdown.js";
import { parseMbox, threadKey } from "./mbox.js";
import { isPasswordsCsvHeader, parsePasswordsCsv } from "./passwords-csv.js";
import { PUBLISHERS } from "./publishers.js";
import type {
  EventPayload,
  LockerItemPayload,
  MediaAssetPayload,
  MessagePayload,
  PartyPayload,
  TransactionPayload,
  NotePayload,
} from "./publishers.js";
import { ensureConnection, stageCandidates } from "./staging.js";
import type { StageCandidate, StageResult } from "./staging.js";
import {
  isMediaPath,
  normalizeArchivePath,
  planTakeout,
  NO_SIDECAR_FACTS,
} from "./takeout-sidecar.js";
import type { TakeoutMediaEntry } from "./takeout-sidecar.js";
import { parseVcards } from "./vcard.js";
import { readZipEntries } from "./zip.js";

export interface StageFileOptions {
  filename: string;
  data: Buffer | string;
  accountName?: string;
  currency?: string;
  captureGroupId?: string;
}

export interface StageFileResult extends StageResult {
  kind: string;
  unrouted: string[];
}

export const MAX_IMPORT_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 100_000;

export function assertImportFileSize(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_IMPORT_FILE_BYTES
  ) {
    throw new Error(`import file exceeds ${MAX_IMPORT_FILE_BYTES} bytes`);
  }
}

function fileBytes(data: Buffer | string, filename: string): Buffer {
  if (Buffer.isBuffer(data)) {
    assertImportFileSize(data.length);
    return data;
  }
  if (extension(filename) === "zip") {
    const compact = data.replace(/\s+/gu, "");
    if (
      compact.length === 0 ||
      compact.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
    ) {
      throw new Error("zip import is not valid base64");
    }
    const decoded = Buffer.from(compact, "base64");
    assertImportFileSize(decoded.length);
    return decoded;
  }
  assertImportFileSize(Buffer.byteLength(data, "utf8"));
  return Buffer.from(data, "utf8");
}

function decodeImportText(data: Buffer, filename: string): string {
  if (
    (data[0] === 0xff && data[1] === 0xfe) ||
    (data[0] === 0xfe && data[1] === 0xff)
  ) {
    throw new Error(`unsupported UTF-16 encoding in ${filename}; use UTF-8`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`invalid UTF-8 in ${filename}`);
  }
  if (text.includes("\0")) throw new Error(`NUL byte in ${filename}`);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function eventCandidates(text: string): StageCandidate[] {
  return parseIcs(text).map((event) => ({
    entityType: "core.event",
    externalId: event.uid,
    payload: {
      uid: event.uid,
      summary: event.summary,
      description: event.description,
      dtstart: event.dtstart,
      dtend: event.dtend,
      startTz: event.startTz,
      rrule: event.rrule,
      status: event.status,
    } satisfies EventPayload as unknown as Record<string, unknown>,
  }));
}

function partyCandidates(text: string): StageCandidate[] {
  return parseVcards(text).map((card, i) => ({
    entityType: "core.party",
    externalId:
      card.identifiers[0] === undefined
        ? `vcard:${card.fn}:${i}`
        : `${card.identifiers[0].scheme}:${card.identifiers[0].value}`,
    payload: {
      fn: card.fn,
      sortName: card.sortName,
      bday: card.bday,
      identifiers: card.identifiers.map((id) => ({
        scheme: id.scheme,
        value: id.value,
        label: id.label ?? null,
      })),
    } satisfies PartyPayload as unknown as Record<string, unknown>,
  }));
}

function messageCandidates(
  db: VaultDb,
  text: string,
  stagedShas: string[]
): StageCandidate[] {
  return parseMbox(text).map((message) => ({
    entityType: "social.message",
    externalId: message.messageId,
    payload: {
      messageId: message.messageId,
      subject: message.subject,
      fromName: message.fromName,
      fromEmail: message.fromEmail,
      sentAt: message.sentAt,
      body: message.body,
      threadKey: threadKey(message.subject),
      attachments: message.attachments.map((a) => {
        const staged = stageBlobBytes(db, {
          bytes: a.data,
          mediaType: a.mediaType,
          filename: a.filename,
        });
        stagedShas.push(staged.sha256);
        return {
          stagedSha: staged.sha256,
          filename: a.filename,
          mediaType: staged.mediaType,
          byteSize: staged.byteSize,
        };
      }),
    } satisfies MessagePayload as unknown as Record<string, unknown>,
  }));
}

function isMediaFile(filename: string, bytes: Buffer): boolean {
  if (!isMediaPath(filename)) return false;
  const type = sniffMediaType(bytes, undefined, filename);
  return type.startsWith("image/") || type.startsWith("video/");
}

function mediaCandidates(
  db: VaultDb,
  entry: TakeoutMediaEntry,
  bytes: Buffer,
  keepLocation: boolean,
  stagedShas: string[]
): StageCandidate[] {
  const filename = entry.path.split("/").at(-1) ?? entry.path;
  const staged = stageBlobBytes(db, { bytes, filename });
  stagedShas.push(staged.sha256);
  return [
    {
      entityType: "media.asset",
      externalId: entry.path,
      payload: {
        stagedSha: staged.sha256,
        filename,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
        path: entry.path,
        capturedAt: entry.sidecar.capturedAt,
        latitude: keepLocation ? entry.sidecar.latitude : null,
        longitude: keepLocation ? entry.sidecar.longitude : null,
        caption: entry.sidecar.caption,
        favorite: entry.sidecar.favorite ? 1 : 0,
        captureGroupId: entry.captureGroupId,
        album: entry.album,
      } satisfies MediaAssetPayload as unknown as Record<string, unknown>,
    },
  ];
}

function transactionCandidates(
  text: string,
  accountName: string,
  fallbackCurrency: string
): StageCandidate[] {
  return parseTransactionsCsv(text).map((txn) => {
    const currency = txn.currency ?? fallbackCurrency;
    const externalId =
      txn.externalId ??
      `csv:${txn.postedAt.slice(0, 10)}:${txn.amountMinor}:${txn.direction}:${txn.description ?? ""}`;
    return {
      entityType: "core.transaction",
      externalId,
      payload: {
        externalId,
        postedAt: txn.postedAt,
        description: txn.description,
        amountMinor: txn.amountMinor,
        currency,
        direction: txn.direction,
        accountName,
      } satisfies TransactionPayload as unknown as Record<string, unknown>,
    };
  });
}

function passwordCandidates(text: string): StageCandidate[] {
  return parsePasswordsCsv(text).map((item) => ({
    entityType: "locker.item",
    externalId: `login:${item.title}:${item.username ?? ""}`,
    payload: {
      title: item.title,
      url: item.url,
      username: item.username,
      password: item.password,
      otpSeed: item.otpSeed,
      notes: item.notes,
    } satisfies LockerItemPayload as unknown as Record<string, unknown>,
  }));
}

function markdownCandidates(filename: string, text: string): StageCandidate[] {
  const note = parseMarkdownNote({ path: filename, text });
  return [
    {
      entityType: "knowledge.note",
      externalId: note.externalId,
      payload: {
        title: note.title,
        body: note.body,
        path: note.path,
      } satisfies NotePayload as unknown as Record<string, unknown>,
    },
  ];
}

function csvCandidates(
  text: string,
  opts: { accountName: string; currency: string }
): StageCandidate[] {
  const header = parseCsvRows(text)[0];
  return header && isPasswordsCsvHeader(header)
    ? passwordCandidates(text)
    : transactionCandidates(text, opts.accountName, opts.currency);
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stem(name: string): string {
  const base = name.split("/").at(-1) ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function baseCurrency(db: VaultDb): string {
  const row = db.vault
    .prepare("SELECT base_currency FROM core_vault LIMIT 1")
    .get() as { base_currency: string } | undefined;
  return row?.base_currency ?? "USD";
}

function candidatesFor(
  db: VaultDb,
  filename: string,
  text: string,
  opts: { accountName: string; currency: string; stagedShas: string[] }
): StageCandidate[] | null {
  switch (extension(filename)) {
    case "ics":
      return eventCandidates(text);
    case "vcf":
    case "vcard":
      return partyCandidates(text);
    case "mbox":
      return messageCandidates(db, text, opts.stagedShas);
    case "csv":
      return csvCandidates(text, opts);
    case "md":
    case "markdown":
      return markdownCandidates(filename, text);
    default:
      return null;
  }
}

export function stageFile(
  db: VaultDb,
  importer: Identity,
  options: StageFileOptions
): StageFileResult {
  const input = fileBytes(options.data, options.filename);
  const currency = options.currency ?? baseCurrency(db);
  const accountName = options.accountName ?? stem(options.filename);
  const unrouted: string[] = [];
  let kind: string;
  const candidates: StageCandidate[] = [];
  const stagedShas: string[] = [];

  const keepLocation = mediaLocationPolicy(db) !== "strip";

  if (extension(options.filename) === "zip") {
    kind = "file.takeout";
    const entries = readZipEntries(input);
    const plan = planTakeout(entries);
    const mediaByPath = new Map(plan.media.map((item) => [item.path, item]));
    for (const entry of entries) {
      const path = normalizeArchivePath(entry.name);
      if (plan.metadata.has(path)) continue;
      const media = mediaByPath.get(path);
      if (media && isMediaFile(path, entry.data)) {
        candidates.push(
          ...mediaCandidates(db, media, entry.data, keepLocation, stagedShas)
        );
        continue;
      }
      const routed = candidatesFor(
        db,
        entry.name,
        decodeImportText(entry.data, entry.name),
        {
          accountName: stem(entry.name),
          currency,
          stagedShas,
        }
      );
      if (routed === null) unrouted.push(entry.name);
      else candidates.push(...routed);
    }
  } else if (isMediaFile(options.filename, input)) {
    kind = `file.${extension(options.filename)}`;
    const path = normalizeArchivePath(options.filename);
    candidates.push(
      ...mediaCandidates(
        db,
        {
          path,
          sidecarPath: null,
          sidecar: NO_SIDECAR_FACTS,
          album: null,
          captureGroupId: options.captureGroupId ?? null,
        },
        input,
        keepLocation,
        stagedShas
      )
    );
  } else {
    const text = decodeImportText(input, options.filename);
    const routed = candidatesFor(db, options.filename, text, {
      accountName,
      currency,
      stagedShas,
    });
    if (routed === null) {
      throw new Error(
        `no importer for "${options.filename}" — supported: .ics, .vcf, .mbox, .csv, .md, photos and videos, .zip`
      );
    }
    kind = `file.${extension(options.filename) === "vcard" ? "vcf" : extension(options.filename)}`;
    candidates.push(...routed);
  }

  if (candidates.length === 0)
    throw new Error(`import contained no valid records: ${options.filename}`);
  if (candidates.length > MAX_IMPORT_RECORDS)
    throw new Error(`import exceeds ${MAX_IMPORT_RECORDS} records`);

  const connectionId = ensureConnection(db, { kind, label: options.filename });
  const result = stageCandidates(
    db,
    importer,
    connectionId,
    candidates,
    PUBLISHERS
  );
  if (stagedShas.length > 0) {
    const hold = db.vault.prepare(
      "UPDATE blob_staging SET held_by_batch = ? WHERE sha256 = ? AND variant IS NULL"
    );
    for (const sha of stagedShas) hold.run(result.batchId, sha);
  }
  return { ...result, kind, unrouted };
}
