// File-drop customs (issue #290 phase 2): one door for every dropped file.
// The extension routes to a parser, parsers produce StageCandidates, and the
// staging spine dispositions them into a reviewable draft batch. A Takeout
// zip is just a bag of the same file kinds — entries route recursively and
// land in ONE batch on one `file.takeout` connection.

import type { VaultDb } from '../db.js';
import type { Identity } from '../gateway/types.js';
import { parseIcs } from './ics.js';
import { parseVcards } from './vcard.js';
import { parseMbox, threadKey } from './mbox.js';
import { parseCsvRows, parseTransactionsCsv } from './csv.js';
import { isPasswordsCsvHeader, parsePasswordsCsv } from './passwords-csv.js';
import { readZipEntries } from './zip.js';
import { PUBLISHERS } from './publishers.js';
import type {
  EventPayload,
  LockerItemPayload,
  MessagePayload,
  PartyPayload,
  TransactionPayload,
} from './publishers.js';
import {
  ensureConnection,
  stageCandidates,
  type StageCandidate,
  type StageResult,
} from './staging.js';

export interface StageFileOptions {
  /** Original filename — routes the parser and labels the connection. */
  filename: string;
  /** File bytes (zip) or text; text sources accept either. */
  data: Buffer | string;
  /** Account name for statement CSVs (default: the filename stem). */
  accountName?: string;
  /** Currency for statement rows that carry none (default: vault base). */
  currency?: string;
}

export interface StageFileResult extends StageResult {
  kind: string;
  /** Zip entries that matched no importer (reported, never silent). */
  unrouted: string[];
}

function eventCandidates(text: string): StageCandidate[] {
  return parseIcs(text).map((event) => ({
    entityType: 'core.event',
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
    entityType: 'core.party',
    externalId:
      card.identifiers[0] !== undefined
        ? `${card.identifiers[0].scheme}:${card.identifiers[0].value}`
        : `vcard:${card.fn}:${i}`,
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

function messageCandidates(text: string): StageCandidate[] {
  return parseMbox(text).map((message) => ({
    entityType: 'social.message',
    externalId: message.messageId,
    payload: {
      messageId: message.messageId,
      subject: message.subject,
      fromName: message.fromName,
      fromEmail: message.fromEmail,
      sentAt: message.sentAt,
      body: message.body,
      threadKey: threadKey(message.subject),
    } satisfies MessagePayload as unknown as Record<string, unknown>,
  }));
}

function transactionCandidates(
  text: string,
  accountName: string,
  fallbackCurrency: string,
): StageCandidate[] {
  return parseTransactionsCsv(text).map((txn) => {
    const currency = txn.currency ?? fallbackCurrency;
    const externalId =
      txn.externalId ??
      `csv:${txn.postedAt.slice(0, 10)}:${txn.amountMinor}:${txn.direction}:${txn.description ?? ''}`;
    return {
      entityType: 'core.transaction',
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
    entityType: 'locker.item',
    // Stable across re-imports of the same export: a login's identity is
    // where + who, not its (rotating) password.
    externalId: `login:${item.title}:${item.username ?? ''}`,
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

/** CSVs route by CONTENT: a password column means a password-manager export. */
function csvCandidates(
  text: string,
  opts: { accountName: string; currency: string },
): StageCandidate[] {
  const header = parseCsvRows(text)[0];
  return header && isPasswordsCsvHeader(header)
    ? passwordCandidates(text)
    : transactionCandidates(text, opts.accountName, opts.currency);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function stem(name: string): string {
  const base = name.split('/').at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function baseCurrency(db: VaultDb): string {
  const row = db.vault.prepare('SELECT base_currency FROM core_vault LIMIT 1').get() as
    | { base_currency: string }
    | undefined;
  return row?.base_currency ?? 'USD';
}

/** Route ONE file's content to candidates. Unknown extensions yield none. */
function candidatesFor(
  filename: string,
  text: string,
  opts: { accountName: string; currency: string },
): StageCandidate[] | null {
  switch (extension(filename)) {
    case 'ics':
      return eventCandidates(text);
    case 'vcf':
    case 'vcard':
      return partyCandidates(text);
    case 'mbox':
      return messageCandidates(text);
    case 'csv':
      return csvCandidates(text, opts);
    default:
      return null;
  }
}

/**
 * Stage a dropped file into a reviewable draft batch. Publishing is the
 * separate explicit act (`publishBatch`) — first contact with real data is
 * always staged (issue #290 decision 2).
 */
export function stageFile(
  db: VaultDb,
  importer: Identity,
  options: StageFileOptions,
): StageFileResult {
  const currency = options.currency ?? baseCurrency(db);
  const accountName = options.accountName ?? stem(options.filename);
  const unrouted: string[] = [];
  let kind: string;
  const candidates: StageCandidate[] = [];

  if (extension(options.filename) === 'zip') {
    kind = 'file.takeout';
    const buffer =
      typeof options.data === 'string' ? Buffer.from(options.data, 'base64') : options.data;
    for (const entry of readZipEntries(buffer)) {
      const routed = candidatesFor(entry.name, entry.data.toString('utf8'), {
        accountName: stem(entry.name),
        currency,
      });
      if (routed === null) unrouted.push(entry.name);
      else candidates.push(...routed);
    }
  } else {
    const text = typeof options.data === 'string' ? options.data : options.data.toString('utf8');
    const routed = candidatesFor(options.filename, text, { accountName, currency });
    if (routed === null) {
      throw new Error(
        `no importer for "${options.filename}" — supported: .ics, .vcf, .mbox, .csv, .zip`,
      );
    }
    kind = `file.${extension(options.filename) === 'vcard' ? 'vcf' : extension(options.filename)}`;
    candidates.push(...routed);
  }

  const connectionId = ensureConnection(db, { kind, label: options.filename });
  const result = stageCandidates(db, importer, connectionId, candidates, PUBLISHERS);
  return { ...result, kind, unrouted };
}
