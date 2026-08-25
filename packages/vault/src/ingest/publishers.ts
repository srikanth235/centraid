// governance: allow-repo-hygiene file-size-limit the per-entity publishers are one closed vocabulary — probe/create/update share the provenance-stamping contract (#290)
// Per-entity-type publishers for the staging spine (#290).
// A publisher is the ONLY code that turns a staged payload into vault rows:
// `probe` adopts rows the vault already holds (domain-native keys — ical_uid,
// party identifiers, external_id columns), `create`/`update` write, and both
// report every touched row so the spine stamps provenance for each.

import type { DatabaseSync } from "node:sqlite";

import { promoteStagedBlob } from "../blob/promote.js";
import { setStarredTx } from "../commands/flags.js";
import { assertTextBodyWithinBudget } from "../commands/inline-body-guard.js";
import {
  adoptAssetForContentTx,
  assetKindFor,
  exifJsonForMeta,
  findOrCreatePlaceTx,
  insertMediaAssetTx,
} from "../commands/media.js";
import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import { ENRICH_PUBLISHERS } from "./enrich-publishers.js";
import { assertPayload } from "./payload-schemas.js";
import type { Publisher, PublishedWrite } from "./staging.js";

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
  entityType: "core.event",
  probe(vault, payload) {
    // Read-only — the runtime schema gate covers WRITE paths only (#374).
    const p = payload as unknown as EventPayload;
    const existing = vault
      .prepare("SELECT event_id FROM core_event WHERE ical_uid = ?")
      .get(p.uid) as { event_id: string } | undefined;
    return existing
      ? {
          entityId: existing.event_id,
          disposition: "skip",
          note: "already in the vault (ical_uid)",
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<EventPayload>("EventPayload", payload);
    const eventId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_event
           (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
            location_place_id, organizer_party_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`
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
        now
      );
    return { entityId: eventId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<EventPayload>("EventPayload", payload);
    vault
      .prepare(
        `UPDATE core_event SET summary = ?, description = ?, dtstart = ?, dtend = ?, start_tz = ?,
            rrule = ?, status = ?, sequence = sequence + 1, updated_at = ?
          WHERE event_id = ?`
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
        entityId
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
  identifiers: PartyPayload["identifiers"]
): PublishedWrite[] {
  const wrote: PublishedWrite[] = [];
  const primarySeen = new Set<string>(
    (
      vault
        .prepare(
          "SELECT scheme FROM core_party_identifier WHERE party_id = ? AND is_primary = 1"
        )
        .all(partyId) as { scheme: string }[]
    ).map((r) => r.scheme)
  );
  for (const identifier of identifiers) {
    const exists = vault
      .prepare(
        "SELECT 1 AS x FROM core_party_identifier WHERE scheme = ? AND value = ?"
      )
      .get(identifier.scheme, identifier.value);
    if (exists) continue;
    const identifierId = uuidv7();
    const isPrimary = primarySeen.has(identifier.scheme) ? 0 : 1;
    primarySeen.add(identifier.scheme);
    vault
      .prepare(
        `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
      )
      .run(
        identifierId,
        partyId,
        identifier.scheme,
        identifier.value,
        identifier.label,
        isPrimary,
        nowIso()
      );
    wrote.push({ type: "core.party_identifier", id: identifierId });
  }
  return wrote;
}

/** Live-handle lookup, newest primary first — the vCard resolution rule. */
function partyByIdentifiers(
  vault: DatabaseSync,
  identifiers: PartyPayload["identifiers"]
): string | null {
  for (const identifier of identifiers) {
    const row = vault
      .prepare(
        `SELECT party_id FROM core_party_identifier
          WHERE scheme = ? AND value = ? AND (valid_to IS NULL OR valid_to > ?)
          ORDER BY is_primary DESC LIMIT 1`
      )
      .get(identifier.scheme, identifier.value, nowIso()) as
      | { party_id: string }
      | undefined;
    if (row) return row.party_id;
  }
  return null;
}

function ensurePeopleProfile(
  vault: DatabaseSync,
  partyId: string,
  now: string
): PublishedWrite[] {
  const existing = vault
    .prepare("SELECT profile_id FROM people_profile WHERE party_id = ?")
    .get(partyId);
  if (existing) return [];
  const profileId = uuidv7();
  vault
    .prepare(
      `INSERT INTO people_profile
         (profile_id, party_id, role, avatar_color, cadence_days,
          last_contacted_at, met, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 30, NULL, NULL, ?, ?)`
    )
    .run(profileId, partyId, now, now);
  return [{ type: "people.profile", id: profileId }];
}

const partyPublisher: Publisher = {
  entityType: "core.party",
  probe(vault, payload) {
    const p = payload as unknown as PartyPayload;
    const partyId = partyByIdentifiers(vault, p.identifiers);
    if (!partyId) return null;
    const missing = p.identifiers.filter(
      (i) =>
        !vault
          .prepare(
            "SELECT 1 AS x FROM core_party_identifier WHERE scheme = ? AND value = ?"
          )
          .get(i.scheme, i.value)
    );
    return missing.length > 0
      ? {
          entityId: partyId,
          disposition: "update",
          note: "existing person; backfills new handles",
        }
      : {
          entityId: partyId,
          disposition: "skip",
          note: "existing person; nothing new",
        };
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<PartyPayload>("PartyPayload", payload);
    const partyId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(partyId, p.fn, p.sortName, p.bday, now, now, ONTOLOGY_VERSION);
    return {
      entityId: partyId,
      wrote: [
        ...bindIdentifiers(vault, partyId, p.identifiers),
        ...ensurePeopleProfile(vault, partyId, now),
      ],
    };
  },
  update(vault, entityId, payload, now) {
    const p = assertPayload<PartyPayload>("PartyPayload", payload);
    // The vault wins: an import never rewrites a person's name or birthday —
    // it only backfills handles the vault has never seen.
    return {
      wrote: [
        ...bindIdentifiers(vault, entityId, p.identifiers),
        ...ensurePeopleProfile(vault, entityId, now),
      ],
    };
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
  /** Staged blob shas the parser hashed into the CAS (#296). */
  attachments?: {
    stagedSha: string;
    filename: string;
    mediaType: string;
    byteSize: number;
  }[];
}

/** Dedupe-or-insert a plain-text body as a canonical content item. */
function textContentItem(
  vault: DatabaseSync,
  text: string,
  creatorPartyId: string | null,
  now: string
): { contentId: string; created: boolean } {
  const sha = sha256Hex(text);
  const existing = vault
    .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
    .get(sha) as { content_id: string } | undefined;
  if (existing) return { contentId: existing.content_id, created: false };
  const contentId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
      sha,
      Buffer.from(text, "utf8").length,
      creatorPartyId,
      now
    );
  return { contentId, created: true };
}

const messagePublisher: Publisher = {
  entityType: "social.message",
  probe(vault, payload) {
    const p = payload as unknown as MessagePayload;
    const existing = vault
      .prepare("SELECT message_id FROM social_message WHERE external_id = ?")
      .get(p.messageId) as { message_id: string } | undefined;
    return existing
      ? {
          entityId: existing.message_id,
          disposition: "skip",
          note: "message already imported",
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<MessagePayload>("MessagePayload", payload);
    const wrote: PublishedWrite[] = [];

    // Sender: resolve by email handle, else mint a person for the address.
    let senderId: string | null = null;
    if (p.fromEmail) {
      const identifiers = [
        { scheme: "email", value: p.fromEmail, label: null },
      ];
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
          now
        );
        senderId = minted.entityId;
        wrote.push({ type: "core.party", id: senderId }, ...minted.wrote);
      }
    }

    // Thread: one per normalized subject per mailbox import.
    const threadRef = `mbox:${sha256Hex(p.threadKey).slice(0, 24)}`;
    let thread = vault
      .prepare("SELECT thread_id FROM social_thread WHERE external_ref = ?")
      .get(threadRef) as { thread_id: string } | undefined;
    if (thread) {
      vault
        .prepare(
          `UPDATE social_thread SET last_message_at = max(coalesce(last_message_at, ''), ?) WHERE thread_id = ?`
        )
        .run(p.sentAt, thread.thread_id);
    } else {
      const threadId = uuidv7();
      vault
        .prepare(
          `INSERT INTO social_thread (thread_id, channel, subject, external_ref, created_at, last_message_at)
           VALUES (?, 'email', ?, ?, ?, ?)`
        )
        .run(threadId, p.subject, threadRef, now, p.sentAt);
      wrote.push({ type: "social.thread", id: threadId });
      thread = { thread_id: threadId };
    }
    if (senderId) {
      const tp = vault
        .prepare(
          "SELECT tp_id FROM social_thread_participant WHERE thread_id = ? AND party_id = ?"
        )
        .get(thread.thread_id, senderId) as { tp_id: string } | undefined;
      if (!tp) {
        const tpId = uuidv7();
        vault
          .prepare(
            `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted, last_read_at)
             VALUES (?, ?, ?, ?, ?, 0, NULL)`
          )
          .run(tpId, thread.thread_id, senderId, p.fromEmail, p.sentAt);
        wrote.push({ type: "social.thread_participant", id: tpId });
      }
    }

    const body = textContentItem(vault, p.body, senderId, now);
    if (body.created)
      wrote.push({ type: "core.content_item", id: body.contentId });
    const messageId = uuidv7();
    vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, in_reply_to_id, delivery, external_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'delivered', ?)`
      )
      .run(
        messageId,
        thread.thread_id,
        senderId,
        p.fromEmail,
        p.sentAt,
        body.contentId,
        p.messageId
      );
    // Email attachments (#296): the parser staged the bytes; publish
    // is the claim — content items promote from the staging band and pin to
    // the message with the same edge core.attach writes.
    for (const att of p.attachments ?? []) {
      const promoted = promoteStagedBlob(
        {
          vault,
          now,
          newId: uuidv7,
          wrote: (type, id) => wrote.push({ type, id }),
          creatorPartyId: senderId,
        },
        att.stagedSha,
        { title: att.filename }
      );
      const isFirst = vault
        .prepare(
          `SELECT count(*) AS n FROM core_attachment WHERE target_type = 'social.message' AND target_id = ?`
        )
        .get(messageId) as { n: number };
      const attachmentId = uuidv7();
      vault
        .prepare(
          `INSERT INTO core_attachment (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
           VALUES (?, 'social.message', ?, ?, ?, ?, ?)`
        )
        .run(
          attachmentId,
          messageId,
          promoted.contentId,
          promoted.mediaType.startsWith("image/") ? "photo" : "other",
          isFirst.n === 0 ? 1 : 0,
          now
        );
      wrote.push({ type: "core.attachment", id: attachmentId });
    }
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
  direction: "debit" | "credit";
  accountName: string;
}

/** Find-or-create the owner's account by name — file drops name accounts. */
function accountFor(
  vault: DatabaseSync,
  ownerPartyId: string,
  name: string,
  currency: string
): { accountId: string; created: boolean } {
  const existing = vault
    .prepare(
      "SELECT account_id FROM core_account WHERE owner_party_id = ? AND name = ?"
    )
    .get(ownerPartyId, name) as { account_id: string } | undefined;
  if (existing) return { accountId: existing.account_id, created: false };
  const accountId = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, institution_party_id, external_ref, is_asset, opened_at, closed_at)
       VALUES (?, ?, ?, 'depository', ?, NULL, NULL, 1, NULL, NULL)`
    )
    .run(accountId, ownerPartyId, name, currency);
  return { accountId, created: true };
}

const transactionPublisher: Publisher = {
  entityType: "core.transaction",
  probe(vault, payload) {
    const p = payload as unknown as TransactionPayload;
    const existing = vault
      .prepare("SELECT txn_id FROM core_transaction WHERE external_id = ?")
      .get(p.externalId) as { txn_id: string } | undefined;
    return existing
      ? {
          entityId: existing.txn_id,
          disposition: "skip",
          note: "transaction already imported",
        }
      : null;
  },
  create(vault, ownerPartyId, payload) {
    const p = assertPayload<TransactionPayload>("TransactionPayload", payload);
    const wrote: PublishedWrite[] = [];
    const account = accountFor(vault, ownerPartyId, p.accountName, p.currency);
    if (account.created)
      wrote.push({ type: "core.account", id: account.accountId });
    const txnId = uuidv7();
    vault
      .prepare(
        `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, transfer_group_id, counterparty_party_id, description, category_concept_id, external_id)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, NULL, ?, NULL, ?)`
      )
      .run(
        txnId,
        account.accountId,
        p.postedAt,
        p.amountMinor,
        p.currency,
        p.direction,
        p.description,
        p.externalId
      );
    return { entityId: txnId, wrote };
  },
  update(vault, entityId, payload) {
    const p = assertPayload<TransactionPayload>("TransactionPayload", payload);
    vault
      .prepare(
        `UPDATE core_transaction SET description = ?, amount_minor = ?, posted_at = ? WHERE txn_id = ?`
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
  entityType: "locker.item",
  probe(vault, payload) {
    const p = payload as unknown as LockerItemPayload;
    const existing = vault
      .prepare(
        `SELECT item_id FROM locker_item
          WHERE type = 'login' AND deleted_at IS NULL AND title = ?
            AND ((username IS NULL AND ? IS NULL) OR username = ?)`
      )
      .get(p.title, p.username, p.username) as { item_id: string } | undefined;
    return existing
      ? {
          entityId: existing.item_id,
          disposition: "update",
          note: "matches an existing login (title + username) — vault wins on publish review",
        }
      : null;
  },
  create(vault, _owner, payload, now) {
    const p = assertPayload<LockerItemPayload>("LockerItemPayload", payload);
    const itemId = uuidv7();
    vault
      .prepare(
        `INSERT INTO locker_item
           (item_id, type, title, username, password, url, otp_seed, notes, compromised, created_at, updated_at)
         VALUES (?, 'login', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        itemId,
        p.title,
        p.username,
        p.password,
        p.url,
        p.otpSeed,
        p.notes,
        now,
        now
      );
    return { entityId: itemId, wrote: [] };
  },
  update(vault, entityId, payload, now) {
    // Source fills gaps, never overwrites: an imported password lands only
    // where the vault holds none (vault-wins, #290 decision 6).
    const p = assertPayload<LockerItemPayload>("LockerItemPayload", payload);
    vault
      .prepare(
        `UPDATE locker_item SET
           url = COALESCE(url, ?), password = COALESCE(password, ?),
           otp_seed = COALESCE(otp_seed, ?), notes = COALESCE(notes, ?), updated_at = ?
         WHERE item_id = ?`
      )
      .run(p.url, p.password, p.otpSeed, p.notes, now, entityId);
    return { wrote: [] };
  },
};

// ── knowledge.note (Markdown directory) ─────────────────────────────────

export interface NotePayload {
  title: string;
  body: string;
  /** Relative file path; parent segments become nested notebooks. */
  path: string;
}

function noteContent(
  vault: DatabaseSync,
  ownerPartyId: string,
  body: string,
  now: string
): { id: string; wrote: PublishedWrite[] } {
  assertTextBodyWithinBudget(body, "text/markdown");
  const sha = sha256Hex(body);
  const existing = vault
    .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
    .get(sha) as { content_id: string } | undefined;
  if (existing) return { id: existing.content_id, wrote: [] };
  const id = uuidv7();
  vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/markdown', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      id,
      `data:text/markdown;charset=utf-8,${encodeURIComponent(body)}`,
      sha,
      Buffer.byteLength(body, "utf8"),
      ownerPartyId,
      now
    );
  return { id, wrote: [{ type: "core.content_item", id }] };
}

/**
 * Find-or-create a nested collection path under one owner, returning the
 * deepest collection. Shared by every importer that files what it publishes
 * (#721): a Markdown directory becomes nested notebooks, a Takeout
 * album folder becomes one flat album — same mechanism, same find-or-create,
 * so an import never mints a second collection with a name the vault holds.
 */
function ensureCollectionPath(
  vault: DatabaseSync,
  ownerPartyId: string,
  segments: readonly string[],
  now: string
): { collectionId: string | null; wrote: PublishedWrite[] } {
  const wrote: PublishedWrite[] = [];
  let parent: string | null = null;
  for (const name of segments) {
    if (!name || name === "." || name === "..") continue;
    const existing = vault
      .prepare(
        `SELECT collection_id FROM core_collection
          WHERE owner_party_id = ? AND name = ?
            AND ((parent_collection_id IS NULL AND ? IS NULL) OR parent_collection_id = ?)
          ORDER BY collection_id LIMIT 1`
      )
      .get(ownerPartyId, name, parent, parent) as
      | { collection_id: string }
      | undefined;
    if (existing) {
      parent = existing.collection_id;
      continue;
    }
    const collectionId = uuidv7();
    const order = vault
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM core_collection
          WHERE owner_party_id = ?
            AND ((parent_collection_id IS NULL AND ? IS NULL) OR parent_collection_id = ?)`
      )
      .get(ownerPartyId, parent, parent) as { n: number };
    vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(collectionId, ownerPartyId, name, parent, order.n, now);
    wrote.push({ type: "core.collection", id: collectionId });
    parent = collectionId;
  }
  return { collectionId: parent, wrote };
}

/** Append a target to a collection, at most once (the UNIQUE decides). */
function addCollectionEntry(
  vault: DatabaseSync,
  collectionId: string,
  targetType: string,
  targetId: string,
  now: string
): PublishedWrite[] {
  const entryId = uuidv7();
  const position = vault
    .prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM core_collection_entry WHERE collection_id = ?"
    )
    .get(collectionId) as { n: number };
  vault
    .prepare(
      `INSERT OR IGNORE INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entryId, collectionId, targetType, targetId, position.n, now);
  const changes = vault.prepare("SELECT changes() AS n").get() as { n: number };
  return changes.n > 0 ? [{ type: "core.collection_entry", id: entryId }] : [];
}

function placeImportedNote(
  vault: DatabaseSync,
  ownerPartyId: string,
  noteId: string,
  path: string,
  now: string
): PublishedWrite[] {
  const segments = path.replaceAll("\\", "/").split("/").slice(0, -1);
  const placed = ensureCollectionPath(vault, ownerPartyId, segments, now);
  if (!placed.collectionId) return placed.wrote;
  return [
    ...placed.wrote,
    ...addCollectionEntry(
      vault,
      placed.collectionId,
      "knowledge.note",
      noteId,
      now
    ),
  ];
}

const notePublisher: Publisher = {
  entityType: "knowledge.note",
  probe(vault, payload) {
    const p = payload as unknown as NotePayload;
    const bodySha = sha256Hex(p.body);
    const existing = vault
      .prepare(
        `SELECT n.note_id, c.sha256
           FROM knowledge_note n JOIN core_content_item c ON c.content_id = n.body_content_id
          WHERE n.title = ? AND n.deleted_at IS NULL
          ORDER BY n.updated_at DESC LIMIT 1`
      )
      .get(p.title) as { note_id: string; sha256: string } | undefined;
    return existing
      ? {
          entityId: existing.note_id,
          disposition: existing.sha256 === bodySha ? "skip" : "update",
          note:
            existing.sha256 === bodySha
              ? "same title and Markdown body"
              : "same title; vault body wins until publish review",
        }
      : null;
  },
  create(vault, ownerPartyId, payload, now) {
    const p = assertPayload<NotePayload>("NotePayload", payload);
    const noteId = uuidv7();
    const content = noteContent(vault, ownerPartyId, p.body, now);
    vault
      .prepare(
        `INSERT INTO knowledge_note
           (note_id, author_party_id, title, body_content_id, format, pinned,
            created_at, updated_at, deleted_at, purge_at)
         VALUES (?, ?, ?, ?, 'markdown', 0, ?, ?, NULL, NULL)`
      )
      .run(noteId, ownerPartyId, p.title, content.id, now, now);
    return {
      entityId: noteId,
      wrote: [
        ...content.wrote,
        ...placeImportedNote(vault, ownerPartyId, noteId, p.path, now),
      ],
    };
  },
  update(vault, entityId, payload, now, ownerPartyId) {
    const p = assertPayload<NotePayload>("NotePayload", payload);
    const content = noteContent(vault, ownerPartyId, p.body, now);
    vault
      .prepare(
        `UPDATE knowledge_note
            SET title = ?, body_content_id = ?, format = 'markdown', updated_at = ?
          WHERE note_id = ?`
      )
      .run(p.title, content.id, now, entityId);
    return { wrote: content.wrote };
  },
};

// ── media.asset (photo-library import, issue #721 A1) ─────────────
// A photograph from a Takeout archive must become the SAME row as one
// uploaded from a phone, so this publisher writes through `media.add_asset`'s
// own primitives (commands/media.ts) rather than a second insert of its own:
// `adoptAssetForContentTx` for the sha-dedupe/restore rule,
// `insertMediaAssetTx` for the row, `findOrCreatePlaceTx` for the place,
// `setStarredTx` for the favorite (the column is a mirror, the tag is the
// truth — #441 A2.1). What is genuinely new here is only what the
// ARCHIVE knows and an upload does not: the sidecar's testimony and the
// album folder it sat in.

export interface MediaAssetPayload {
  /** Bytes already in the CAS (#296) — the sha is also their identity. */
  stagedSha: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  /** Archive-relative path — the stable Takeout identity, and the external id. */
  path: string;
  /** Sidecar capture time. NULL is a fact: nobody knows when this was taken. */
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  caption: string | null;
  favorite: 0 | 1;
  captureGroupId: string | null;
  album: string | null;
}

/** File a published asset into its reconstructed album. */
function placeImportedAsset(
  vault: DatabaseSync,
  ownerPartyId: string,
  assetId: string,
  album: string,
  now: string
): PublishedWrite[] {
  const placed = ensureCollectionPath(vault, ownerPartyId, [album], now);
  if (!placed.collectionId) return placed.wrote;
  const wrote = [
    ...placed.wrote,
    ...addCollectionEntry(
      vault,
      placed.collectionId,
      "media.asset",
      assetId,
      now
    ),
  ];
  // The first photo into a coverless album becomes its cover — the same rule
  // `media.add_to_album` applies, so a reconstructed album has a face too.
  vault
    .prepare(
      `UPDATE core_collection SET cover_content_id =
         (SELECT content_id FROM media_asset WHERE asset_id = ?)
       WHERE collection_id = ? AND cover_content_id IS NULL`
    )
    .run(assetId, placed.collectionId);
  return wrote;
}

const mediaAssetPublisher: Publisher = {
  entityType: "media.asset",
  probe(vault, payload) {
    // Read-only lookup — see the eventPublisher note above. DEDUPE AGAINST
    // THE WHOLE VAULT, not just this connection's map: the same photograph
    // re-exported under a different archive name, or already uploaded from
    // the phone, is the same bytes and therefore the same asset. Canonical
    // sha256 is what says so (core_content_item.sha256 is UNIQUE).
    const p = payload as unknown as MediaAssetPayload;
    if (typeof p.stagedSha !== "string") return null;
    const existing = vault
      .prepare(
        `SELECT a.asset_id FROM media_asset a
           JOIN core_content_item c ON c.content_id = a.content_id
          WHERE c.sha256 = ? AND a.deleted_at IS NULL`
      )
      .get(p.stagedSha) as { asset_id: string } | undefined;
    return existing
      ? {
          entityId: existing.asset_id,
          disposition: "skip",
          note: "these bytes are already in the library",
        }
      : null;
  },
  create(vault, ownerPartyId, payload, now) {
    const p = assertPayload<MediaAssetPayload>("MediaAssetPayload", payload);
    const wrote: PublishedWrite[] = [];
    const collect = (entityType: string, entityId: string): void => {
      wrote.push({ type: entityType, id: entityId });
    };
    const deps = { vault, now, newId: uuidv7, wrote: collect };
    const promoted = promoteStagedBlob(
      { ...deps, creatorPartyId: ownerPartyId },
      p.stagedSha,
      p.caption === null ? {} : { title: p.caption }
    );
    // Two entries of the same bytes inside ONE archive (Takeout's `(1)`
    // duplicates) both staged as creates, because neither was in the vault
    // when the batch was dispositioned. The second one adopts the first's
    // asset here instead of hitting the content_id UNIQUE.
    const adopted = adoptAssetForContentTx(
      deps,
      promoted.contentId,
      p.captureGroupId
    );
    const meta = promoted.meta;
    const assetId = adopted ?? uuidv7();
    if (!adopted) {
      // SIDECAR BEATS EXIF BEATS NOTHING. Google Photos' record of when a
      // photo was taken survives edits, re-encodes and stripped EXIF, so it
      // wins where it exists. The file's own mtime is deliberately NOT a
      // third tier: a zip stores whatever the exporter's machine felt like
      // stamping, so it dates the EXPORT, not the photograph. When neither
      // source knows, captured_at stays NULL and the photo lands undated —
      // an honest gap the timeline can say out loud.
      const latitude = p.latitude ?? meta.latitude ?? null;
      const longitude = p.longitude ?? meta.longitude ?? null;
      insertMediaAssetTx(vault, {
        assetId,
        contentId: promoted.contentId,
        kind: assetKindFor(promoted.mediaType),
        capturedAt: p.capturedAt ?? meta.captured_at ?? null,
        // Takeout's timestamp is a UTC instant with no zone beside it, and
        // EXIF's is zoneless local — neither states an offset, so there is
        // nothing honest to put here.
        tzOffsetMin: null,
        captureGroupId: p.captureGroupId,
        sourceAssetId: null,
        placeId:
          latitude !== null && longitude !== null
            ? findOrCreatePlaceTx(deps, latitude, longitude)
            : null,
        width: meta.width ?? null,
        height: meta.height ?? null,
        durationS: meta.duration_s ?? null,
        exifJson: exifJsonForMeta(meta),
      });
    }
    applyImportedAssetFlags(deps, ownerPartyId, assetId, p);
    if (p.album !== null) {
      wrote.push(
        ...placeImportedAsset(vault, ownerPartyId, assetId, p.album, now)
      );
    }
    return { entityId: assetId, wrote };
  },
  update(vault, entityId, payload, now, ownerPartyId) {
    const p = assertPayload<MediaAssetPayload>("MediaAssetPayload", payload);
    const wrote: PublishedWrite[] = [];
    const collect = (entityType: string, entityId2: string): void => {
      wrote.push({ type: entityType, id: entityId2 });
    };
    const deps = { vault, now, newId: uuidv7, wrote: collect };
    // An `update` row is the owner having REVIEWED this diff and pressed
    // publish, so the sidecar's caption, favorite and capture time apply.
    // Two exceptions, both about not destroying what the vault knows: a
    // sidecar with NO capture time may not erase one the vault has (COALESCE
    // — honest absence upstream is not a correction), and a capture group is
    // additive, never re-pointed.
    vault
      .prepare(
        `UPDATE media_asset
            SET captured_at = COALESCE(?, captured_at),
                capture_group_id = COALESCE(capture_group_id, ?)
          WHERE asset_id = ?`
      )
      .run(p.capturedAt, p.captureGroupId, entityId);
    if (p.caption !== null) {
      vault
        .prepare(
          `UPDATE core_content_item SET title = ?
            WHERE content_id = (SELECT content_id FROM media_asset WHERE asset_id = ?)`
        )
        .run(p.caption, entityId);
    }
    applyImportedAssetFlags(deps, ownerPartyId, entityId, p);
    if (p.album !== null) {
      wrote.push(
        ...placeImportedAsset(vault, ownerPartyId, entityId, p.album, now)
      );
    }
    return { wrote };
  },
};

/**
 * The favorite bit, mirrored onto the canonical starred tag exactly as the
 * media commands do. Only ever SETS: an import fills gaps, it never clears a
 * star the owner put on a photo here (#290 decision 6).
 */
function applyImportedAssetFlags(
  deps: {
    vault: DatabaseSync;
    now: string;
    newId: () => string;
    wrote: (entityType: string, entityId: string) => void;
  },
  ownerPartyId: string,
  assetId: string,
  payload: MediaAssetPayload
): void {
  if (payload.favorite !== 1) return;
  deps.vault
    .prepare("UPDATE media_asset SET favorite = 1 WHERE asset_id = ?")
    .run(assetId);
  const row = deps.vault
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(assetId) as { content_id: string } | undefined;
  if (!row) return;
  setStarredTx(
    { ...deps, actorPartyId: () => ownerPartyId },
    "core.content_item",
    row.content_id,
    true
  );
}

/** The publisher registry the spine walks. */
export const PUBLISHERS: ReadonlyMap<string, Publisher> = new Map(
  [
    eventPublisher,
    partyPublisher,
    messagePublisher,
    transactionPublisher,
    lockerItemPublisher,
    notePublisher,
    mediaAssetPublisher,
    ...ENRICH_PUBLISHERS,
  ].map((p) => [p.entityType, p])
);
