// One card per received share, on the AUDIENCE's notices store (#883
// V-notice). ONCE PER GRANT, never per item: `(kind, sourceRef)` makes it
// idempotent, but the read guard still earns its place — `put` clears
// `read_at`, so a re-put resurfaces a read card on every pass. No `deepLink`:
// no route means "the thing Priya just shared".

import type { VaultDb } from "@centraid/vault";

import { NoticeStore } from "./notices.js";
import type { Notice, PutNotice } from "./notices.js";

export const SHARE_RECEIVED_NOTICE_KIND = "share-received";

const SUBJECT_WORDS: Readonly<Record<string, string>> = {
  "core.collection": "an album",
  "core.content_item": "a file",
  "core.document": "a document",
  "docs.folder": "a folder",
  "media.asset": "a photo",
  "tally.group": "a shared expense group",
};

export function shareReceivedNotice(input: {
  grantId: string;
  granterName: string;
  subjectType: string;
  subjectLabel?: string;
  originVaultId: string;
}): PutNotice {
  const what =
    input.subjectLabel ?? SUBJECT_WORDS[input.subjectType] ?? "something";
  return {
    kind: SHARE_RECEIVED_NOTICE_KIND,
    sourceRef: input.grantId,
    headline: `${input.granterName} shared ${what} with you`,
    detail: {
      grantId: input.grantId,
      granterName: input.granterName,
      originVaultId: input.originVaultId,
      sourceType: "share",
      subjectType: input.subjectType,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
    },
    severity: "info",
  };
}

function granterName(origin: VaultDb, granterPartyId: string): string {
  const row = origin.vault
    .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
    .get(granterPartyId) as { display_name: string } | undefined;
  if (row?.display_name) return row.display_name;
  const vault = origin.vault
    .prepare("SELECT display_name FROM core_vault LIMIT 1")
    .get() as { display_name: string } | undefined;
  return vault?.display_name ?? "A vault you are linked with";
}

// Never throws: a card must not turn a delivered share into a failed pass.
export function raiseShareReceivedNotice(input: {
  origin: VaultDb;
  originVaultId: string;
  seat: VaultDb;
  grantId: string;
  granterPartyId: string;
  subjectType: string;
  subjectLabel?: string;
  now?: string;
}): Notice | undefined {
  try {
    const store = new NoticeStore(input.seat.vault);
    const standing = store.getBySource(
      SHARE_RECEIVED_NOTICE_KIND,
      input.grantId
    );
    if (standing) return undefined;
    return store.put({
      ...shareReceivedNotice({
        grantId: input.grantId,
        granterName: granterName(input.origin, input.granterPartyId),
        subjectType: input.subjectType,
        ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        originVaultId: input.originVaultId,
      }),
      ...(input.now ? { at: input.now } : {}),
    });
  } catch {
    return undefined;
  }
}

export const SHARE_SYNCING_NOTICE_KIND = "share-not-delivered";

/**
 * HOW LONG A DELIVERY MAY BE SILENT (#1014, T15). A cross-host grant leaves
 * the pass `syncing` and the sweep drains it when the audience answers; if the
 * audience never does, the row stays `syncing` FOREVER and the owner is told
 * nothing — the one indefinite silent non-delivery state in the share plane
 * ([ARCHITECTURE.md](../../../../ARCHITECTURE.md)). This is how long the
 * plane's own retries get before the owner is told, not a timeout: nothing is
 * cancelled, and the sweep keeps trying.
 */
export const SHARE_SYNCING_NOTICE_AFTER_MS = 15 * 60 * 1000;

interface SyncingAge {
  grantedAt: string;
  deliveredAt: string | null;
}

function fulfillmentAge(
  origin: VaultDb,
  grantId: string,
  peerVaultId: string
): SyncingAge | undefined {
  const row = origin.vault
    .prepare(
      `SELECT a.granted_at AS granted_at, f.delivered_at AS delivered_at
         FROM share_fulfillment f
         JOIN share_authority a ON a.authority_id = f.grant_id
        WHERE f.grant_id = ? AND f.peer_vault_id = ?`
    )
    .get(grantId, peerVaultId) as
    | { granted_at: string; delivered_at: string | null }
    | undefined;
  return row
    ? { grantedAt: row.granted_at, deliveredAt: row.delivered_at }
    : undefined;
}

/**
 * Tell the OWNER — on their own vault, because they are the one who shared —
 * that a share they made has not been confirmed by the vault it was for. Never
 * throws: a card must not turn a stalled pass into a failed one.
 */
export function raiseShareSyncingNotice(input: {
  origin: VaultDb;
  grantId: string;
  peerVaultId: string;
  peerLabel?: string;
  detail?: string;
  now: string;
}): Notice | undefined {
  try {
    const age = fulfillmentAge(input.origin, input.grantId, input.peerVaultId);
    // A grant that HAS been delivered once is a different fact: the audience
    // has answered before, and a stalled follow-up is not silence.
    if (!age || age.deliveredAt !== null) return undefined;
    const waited = Date.parse(input.now) - Date.parse(age.grantedAt);
    if (!Number.isFinite(waited) || waited < SHARE_SYNCING_NOTICE_AFTER_MS)
      return undefined;
    const who = input.peerLabel ?? input.peerVaultId;
    const store = new NoticeStore(input.origin.vault);
    const standing = store.getBySource(
      SHARE_SYNCING_NOTICE_KIND,
      noticeRef(input.grantId, input.peerVaultId)
    );
    // One card per (grant, peer): `put` clears `read_at`, so a re-put on every
    // sweep pass would resurface a card the owner has already read. An
    // ARCHIVED one is a delivery that landed and stalled again, which is a new
    // silence and gets a new card.
    if (standing && standing.archivedAt === null) return undefined;
    return store.put({
      kind: SHARE_SYNCING_NOTICE_KIND,
      sourceRef: noticeRef(input.grantId, input.peerVaultId),
      headline: `${who} has not confirmed the share you sent`,
      detail: {
        grantId: input.grantId,
        peerVaultId: input.peerVaultId,
        sourceType: "share",
        ...(input.detail ? { reason: input.detail } : {}),
      },
      severity: "warning",
      at: input.now,
    });
  } catch {
    return undefined;
  }
}

/** Cleared on delivery — the card is about silence, and it has ended. */
export function clearShareSyncingNotice(input: {
  origin: VaultDb;
  grantId: string;
  peerVaultId: string;
  now: string;
}): void {
  try {
    const store = new NoticeStore(input.origin.vault);
    const standing = store.getBySource(
      SHARE_SYNCING_NOTICE_KIND,
      noticeRef(input.grantId, input.peerVaultId)
    );
    if (standing) store.archive(standing.noticeId, input.now);
  } catch {
    // A card that outlives its fact is a nuisance; a throw here would turn a
    // delivered share into a failed pass.
  }
}

/** One card per (grant, peer): a share to three people can stall for one. */
function noticeRef(grantId: string, peerVaultId: string): string {
  return `${grantId}:${peerVaultId}`;
}
