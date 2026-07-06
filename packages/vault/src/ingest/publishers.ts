// Per-entity-type publishers for the staging spine (issue #290 phase 2).
// A publisher is the ONLY code that turns a staged payload into vault rows:
// `probe` adopts rows the vault already holds (domain-native keys — ical_uid,
// party identifiers, external_id columns), `create`/`update` write, and both
// report every touched row so the spine stamps provenance for each.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, sha256Hex, uuidv7 } from '../ids.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import type { Publisher, PublishedWrite } from './staging.js';

// ── core.event (ICS) ────────────────────────────────────────────────────

export interface EventPayload {
  uid: string;
  summary: string;
  description: string | null;
  dtstart: string;
  dtend: string | null;
  startTz: string | null;
  rrule: string | null;
  status: string;
}

const eventPublisher: Publisher = {
  entityType: 'core.event',
  probe(vault, payload) {
    const p = payload as unknown as EventPayload;
    const existing = vault
      .prepare('SELECT event_id FROM core_event WHERE ical_uid = ?')
      .get(p.uid) as { event_id: string } | undefined;
    return existing
      ? {
          entityId: existing.event_id,
          disposition: 'skip',
          note: 'already in the vault (ical_uid)',
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = payload as unknown as EventPayload;
    const eventId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_event
           (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
            location_place_id, organizer_party_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        eventId,
        p.uid,
        p.summary,
        p.description,
        p.dtstart,
        p.dtend,
        p.startTz,
        p.rrule,
        p.status,
        now,
        now,
      );
    return { entityId: eventId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    const p = payload as unknown as EventPayload;
    vault
      .prepare(
        `UPDATE core_event SET summary = ?, description = ?, dtstart = ?, dtend = ?, start_tz = ?,
            rrule = ?, status = ?, sequence = sequence + 1, updated_at = ?
          WHERE event_id = ?`,
      )
      .run(
        p.summary,
        p.description,
        p.dtstart,
        p.dtend,
        p.startTz,
        p.rrule,
        p.status,
        now,
        entityId,
      );
    return { wrote: [] };
  },
};

// ── core.party (vCard, message senders) ─────────────────────────────────

export interface PartyPayload {
  fn: string;
  sortName: string | null;
  bday: string | null;
  identifiers: { scheme: string; value: string; label: string | null }[];
}

/** Bind identifiers to a party, skipping (scheme,value) pairs any party holds. */
function bindIdentifiers(
  vault: DatabaseSync,
  partyId: string,
  identifiers: PartyPayload['identifiers'],
): PublishedWrite[] {
  const wrote: PublishedWrite[] = [];
  const primarySeen = new Set<string>(
    (
      vault
        .prepare('SELECT scheme FROM core_party_identifier WHERE party_id = ? AND is_primary = 1')
        .all(partyId) as { scheme: string }[]
    ).map((r) => r.scheme),
  );
  for (const identifier of identifiers) {
    const exists = vault
      .prepare('SELECT 1 AS x FROM core_party_identifier WHERE scheme = ? AND value = ?')
      .get(identifier.scheme, identifier.value);
    if (exists) continue;
    const identifierId = uuidv7();
    const isPrimary = primarySeen.has(identifier.scheme) ? 0 : 1;
    primarySeen.add(identifier.scheme);
    vault
      .prepare(
        `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        identifierId,
        partyId,
        identifier.scheme,
        identifier.value,
        identifier.label,
        isPrimary,
        nowIso(),
      );
    wrote.push({ type: 'core.party_identifier', id: identifierId });
  }
  return wrote;
}

/** Live-handle lookup, newest primary first — the vCard resolution rule. */
function partyByIdentifiers(
  vault: DatabaseSync,
  identifiers: PartyPayload['identifiers'],
): string | null {
  for (const identifier of identifiers) {
    const row = vault
      .prepare(
        `SELECT party_id FROM core_party_identifier
          WHERE scheme = ? AND value = ? AND (valid_to IS NULL OR valid_to > ?)
          ORDER BY is_primary DESC LIMIT 1`,
      )
      .get(identifier.scheme, identifier.value, nowIso()) as { party_id: string } | undefined;
    if (row) return row.party_id;
  }
  return null;
}

const partyPublisher: Publisher = {
  entityType: 'core.party',
  probe(vault, payload) {
    const p = payload as unknown as PartyPayload;
    const partyId = partyByIdentifiers(vault, p.identifiers);
    if (!partyId) return null;
    const missing = p.identifiers.filter(
      (i) =>
        !vault
          .prepare('SELECT 1 AS x FROM core_party_identifier WHERE scheme = ? AND value = ?')
          .get(i.scheme, i.value),
    );
    return missing.length > 0
      ? { entityId: partyId, disposition: 'update', note: 'existing person; backfills new handles' }
      : { entityId: partyId, disposition: 'skip', note: 'existing person; nothing new' };
  },
  create(vault, _owner, payload, now) {
    const p = payload as unknown as PartyPayload;
    const partyId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(partyId, p.fn, p.sortName, p.bday, now, now, ONTOLOGY_VERSION);
    return { entityId: partyId, wrote: bindIdentifiers(vault, partyId, p.identifiers) };
  },
  update(vault, entityId, payload) {
    const p = payload as unknown as PartyPayload;
    // The vault wins: an import never rewrites a person's name or birthday —
    // it only backfills handles the vault has never seen.
    return { wrote: bindIdentifiers(vault, entityId, p.identifiers) };
  },
};

// ── social.message (MBOX) ───────────────────────────────────────────────

export interface MessagePayload {
  messageId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  sentAt: string;
  body: string;
  /** Normalized subject — the thread grouping key. */
  threadKey: string;
}

/** Dedupe-or-insert a plain-text body as a canonical content item. */
function textContentItem(
  vault: DatabaseSync,
  text: string,
  creatorPartyId: string | null,
  now: string,
): { contentId: string; created: boolean } {
  const sha = sha256Hex(text);
  const existing = vault
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string } | undefined;
  if (existing) return { contentId: existing.content_id, created: false };
  const contentId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      contentId,
      `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
      sha,
      Buffer.from(text, 'utf8').length,
      creatorPartyId,
      now,
    );
  return { contentId, created: true };
}

const messagePublisher: Publisher = {
  entityType: 'social.message',
  probe(vault, payload) {
    const p = payload as unknown as MessagePayload;
    const existing = vault
      .prepare('SELECT message_id FROM social_message WHERE external_id = ?')
      .get(p.messageId) as { message_id: string } | undefined;
    return existing
      ? { entityId: existing.message_id, disposition: 'skip', note: 'message already imported' }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = payload as unknown as MessagePayload;
    const wrote: PublishedWrite[] = [];

    // Sender: resolve by email handle, else mint a person for the address.
    let senderId: string | null = null;
    if (p.fromEmail) {
      const identifiers = [{ scheme: 'email', value: p.fromEmail, label: null }];
      senderId = partyByIdentifiers(vault, identifiers);
      if (!senderId) {
        const minted = partyPublisher.create(
          vault,
          _owner,
          {
            fn: p.fromName ?? p.fromEmail,
            sortName: null,
            bday: null,
            identifiers,
          } satisfies PartyPayload as unknown as Record<string, unknown>,
          now,
        );
        senderId = minted.entityId;
        wrote.push({ type: 'core.party', id: senderId }, ...minted.wrote);
      }
    }

    // Thread: one per normalized subject per mailbox import.
    const threadRef = `mbox:${sha256Hex(p.threadKey).slice(0, 24)}`;
    let thread = vault
      .prepare('SELECT thread_id FROM social_thread WHERE external_ref = ?')
      .get(threadRef) as { thread_id: string } | undefined;
    if (!thread) {
      const threadId = uuidv7();
      vault
        .prepare(
          `INSERT INTO social_thread (thread_id, channel, subject, external_ref, created_at, last_message_at)
           VALUES (?, 'email', ?, ?, ?, ?)`,
        )
        .run(threadId, p.subject, threadRef, now, p.sentAt);
      wrote.push({ type: 'social.thread', id: threadId });
      thread = { thread_id: threadId };
    } else {
      vault
        .prepare(
          `UPDATE social_thread SET last_message_at = max(coalesce(last_message_at, ''), ?) WHERE thread_id = ?`,
        )
        .run(p.sentAt, thread.thread_id);
    }
    if (senderId) {
      const tp = vault
        .prepare('SELECT tp_id FROM social_thread_participant WHERE thread_id = ? AND party_id = ?')
        .get(thread.thread_id, senderId) as { tp_id: string } | undefined;
      if (!tp) {
        const tpId = uuidv7();
        vault
          .prepare(
            `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted, last_read_at)
             VALUES (?, ?, ?, ?, ?, 0, NULL)`,
          )
          .run(tpId, thread.thread_id, senderId, p.fromEmail, p.sentAt);
        wrote.push({ type: 'social.thread_participant', id: tpId });
      }
    }

    const body = textContentItem(vault, p.body, senderId, now);
    if (body.created) wrote.push({ type: 'core.content_item', id: body.contentId });
    const messageId = uuidv7();
    vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, in_reply_to_id, delivery, external_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'delivered', ?)`,
      )
      .run(
        messageId,
        thread.thread_id,
        senderId,
        p.fromEmail,
        p.sentAt,
        body.contentId,
        p.messageId,
      );
    return { entityId: messageId, wrote };
  },
  update() {
    // Mail is immutable — a mapped message never changes upstream; anything
    // that looks like an update is a re-parse artifact and applies nothing.
    return { wrote: [] };
  },
};

// ── core.transaction (bank CSV) ─────────────────────────────────────────

export interface TransactionPayload {
  externalId: string;
  postedAt: string;
  description: string | null;
  amountMinor: number;
  currency: string;
  direction: 'debit' | 'credit';
  accountName: string;
}

/** Find-or-create the owner's account by name — file drops name accounts. */
function accountFor(
  vault: DatabaseSync,
  ownerPartyId: string,
  name: string,
  currency: string,
): { accountId: string; created: boolean } {
  const existing = vault
    .prepare('SELECT account_id FROM core_account WHERE owner_party_id = ? AND name = ?')
    .get(ownerPartyId, name) as { account_id: string } | undefined;
  if (existing) return { accountId: existing.account_id, created: false };
  const accountId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, institution_party_id, external_ref, is_asset, opened_at, closed_at)
       VALUES (?, ?, ?, 'depository', ?, NULL, NULL, 1, NULL, NULL)`,
    )
    .run(accountId, ownerPartyId, name, currency);
  return { accountId, created: true };
}

const transactionPublisher: Publisher = {
  entityType: 'core.transaction',
  probe(vault, payload) {
    const p = payload as unknown as TransactionPayload;
    const existing = vault
      .prepare('SELECT txn_id FROM core_transaction WHERE external_id = ?')
      .get(p.externalId) as { txn_id: string } | undefined;
    return existing
      ? { entityId: existing.txn_id, disposition: 'skip', note: 'transaction already imported' }
      : null;
  },
  create(vault, ownerPartyId, payload) {
    const p = payload as unknown as TransactionPayload;
    const wrote: PublishedWrite[] = [];
    const account = accountFor(vault, ownerPartyId, p.accountName, p.currency);
    if (account.created) wrote.push({ type: 'core.account', id: account.accountId });
    const txnId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, transfer_group_id, counterparty_party_id, description, category_concept_id, external_id)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, NULL, ?, NULL, ?)`,
      )
      .run(
        txnId,
        account.accountId,
        p.postedAt,
        p.amountMinor,
        p.currency,
        p.direction,
        p.description,
        p.externalId,
      );
    return { entityId: txnId, wrote };
  },
  update(vault, entityId, payload) {
    const p = payload as unknown as TransactionPayload;
    vault
      .prepare(
        `UPDATE core_transaction SET description = ?, amount_minor = ?, posted_at = ? WHERE txn_id = ?`,
      )
      .run(p.description, p.amountMinor, p.postedAt, entityId);
    return { wrote: [] };
  },
};

// ── locker.item (password-manager CSV, issue #293) ─────────────────────
// Secret fields ride the payload sealed (the spine seals them at stage time
// and unseals them just-in-time for this publisher); the spine re-seals the
// written row's columns before the transaction commits. This publisher only
// shapes rows — it never sees the vault's key.

export interface LockerItemPayload {
  title: string;
  url: string | null;
  username: string | null;
  password: string | null;
  otpSeed: string | null;
  notes: string | null;
}

const lockerItemPublisher: Publisher = {
  entityType: 'locker.item',
  probe(vault, payload) {
    const p = payload as unknown as LockerItemPayload;
    const existing = vault
      .prepare(
        `SELECT item_id FROM locker_item
          WHERE type = 'login' AND deleted_at IS NULL AND title = ?
            AND ((username IS NULL AND ? IS NULL) OR username = ?)`,
      )
      .get(p.title, p.username, p.username) as { item_id: string } | undefined;
    return existing
      ? {
          entityId: existing.item_id,
          disposition: 'update',
          note: 'matches an existing login (title + username) — vault wins on publish review',
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = payload as unknown as LockerItemPayload;
    const itemId = uuidv7();
    vault
      .prepare(
        `INSERT INTO locker_item
           (item_id, type, title, username, password, url, otp_seed, notes, compromised, created_at, updated_at)
         VALUES (?, 'login', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(itemId, p.title, p.username, p.password, p.url, p.otpSeed, p.notes, now, now);
    return { entityId: itemId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    // Source fills gaps, never overwrites: an imported password lands only
    // where the vault holds none (vault-wins, issue #290 decision 6).
    const p = payload as unknown as LockerItemPayload;
    vault
      .prepare(
        `UPDATE locker_item SET
           url = COALESCE(url, ?), password = COALESCE(password, ?),
           otp_seed = COALESCE(otp_seed, ?), notes = COALESCE(notes, ?), updated_at = ?
         WHERE item_id = ?`,
      )
      .run(p.url, p.password, p.otpSeed, p.notes, now, entityId);
    return { wrote: [] };
  },
};

/** The publisher registry the spine walks. */
export const PUBLISHERS: ReadonlyMap<string, Publisher> = new Map(
  [eventPublisher, partyPublisher, messagePublisher, transactionPublisher, lockerItemPublisher].map(
    (p) => [p.entityType, p],
  ),
);
