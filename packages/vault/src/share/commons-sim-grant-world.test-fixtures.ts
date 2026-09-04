// Physical world for the SHARE-GRANT half of the Commons simulator (#839):
// the grant plane hangs off the SAME on-disk vaults the commons rail uses.
// Two isolation rules keep that safe.
//
//   1. THE AUDIENCE IS A SYNTHETIC PARTY ON A SYNTHETIC PEER VAULT ID, because
//      the rail resolves a member with a single-row `SELECT party_id FROM
//      share_party_vault_binding WHERE vault_id = ?`.
//   2. PLANE SEATS ARE STEWARD SEATS ONLY: `stale_restore` rewinds a whole
//      SQLite file, resurrecting projections a revocation hard-deleted, and
//      stewards are never rewound (`replicaOnlySeats`).

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { Credential } from "../gateway/types.js";
import type { ShareShapeTransport } from "../grant/fulfillment.js";
import type { ShareFulfillmentState } from "../grant/grant-store.js";
import { uuidv7 } from "../ids.js";
import type { Seat, World } from "./commons-sim-world.test-fixtures.js";
import { NOW, armConfirmGate } from "./commons-sim-world.test-fixtures.js";
import {
  bindPartyToVault,
  revokePartyVaultBinding,
} from "./party-vault-binding.js";
import type { ShareVaultRef } from "./placement.js";
import { loopbackShareTransports } from "./subscription-transport.js";

/** Marked loud so a non-owner caller parks on it. Deliberately OUTSIDE the
 *  commons routing table, so parking never disturbs the tally oracle. */
export const PARKING_COMMAND = "tally.add_friend";

export interface GrantAlbum {
  albumId: string;
  /** The ORIGIN's titles in album order — the model's copy of truth. */
  titles: string[];
  /** Monotonic, so every photo's bytes are its own. */
  minted: number;
}

/** One (origin, audience, subject) triple and its grant lifecycle. */
export interface ShareSlot {
  key: string;
  origin: Seat;
  audience: Seat;
  /** Known only to the origin vault. */
  audiencePartyId: string;
  /** Where this slot delivers — isolation rule 1. */
  peerVaultId: string;
  album: GrantAlbum;
  grantId?: string;
  /** Standing until revoked, and never re-granted. */
  revoked: boolean;
  /** Models `share_fulfillment.state`; absent until a row exists. */
  fulfillment?: ShareFulfillmentState;
  linked: boolean;
  /** Edited behind the origin's back; a delivered pass heals it. */
  tampered: boolean;
  /** A non-vacuity witness. */
  everDelivered: boolean;
  /** The row fell back from `delivered` to `syncing`. A NON-VACUITY witness
   *  (#846 P1): without a degraded row, `checkSeverance` proves nothing. */
  reachLostAfterDelivery: boolean;
}

export interface ParkedFact {
  seat: Seat;
  invocationId: string;
  consentGrantId: string;
  settled: boolean;
  how?: "approved" | "denied" | "consent-revoked";
}

export interface PlaneAgent {
  credential: Credential;
  agentPartyId: string;
  consentGrantId: string;
}

export interface GrantPlane {
  /** Seats the plane runs on (stewards only). */
  seats: Seat[];
  slots: ShareSlot[];
  agents: Map<number, PlaneAgent>;
  parked: ParkedFact[];
}

/** `undefined` means "this host cannot reach that vault right now" — the fact
 *  `startShareSubscription` and `stopShareSubscription` branch on. */
export function seatRefFor(
  plane: GrantPlane,
  reachable: boolean
): (vaultId: string) => ShareVaultRef | undefined {
  return (vaultId) => {
    if (!reachable) return undefined;
    const slot = plane.slots.find((entry) => entry.peerVaultId === vaultId);
    return slot?.audience.db;
  };
}

/** The same reach, as the loopback transport the subscription rail takes. */
export function transportRefFor(
  plane: GrantPlane,
  reachable: boolean,
  origin: ShareVaultRef
): (vaultId: string) => ShareShapeTransport | undefined {
  return loopbackShareTransports({
    origin,
    seatFor: seatRefFor(plane, reachable),
    now: () => NOW,
  });
}

function insertPhoto(seat: Seat, label: string): string {
  const original = seat.db.blobs.ingestSync(
    Buffer.from(`commons-sim-original-${label}`)
  );
  const thumb = seat.db.blobs.ingestSync(
    Buffer.from(`commons-sim-thumb-${label}`)
  );
  const contentId = uuidv7();
  seat.db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title,
          language, creator_party_id, origin_device_id, deleted_at, purge_at,
          created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      `blob:${original.sha256}`,
      original.sha256,
      original.byteSize,
      label,
      NOW
    );
  seat.db.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size,
          text_content, created_at)
       VALUES (?, ?, 'thumb', ?, 'image/jpeg', ?, NULL, ?)`
    )
    .run(uuidv7(), contentId, thumb.sha256, thumb.byteSize, NOW);
  const assetId = uuidv7();
  seat.db.vault
    .prepare(
      `INSERT INTO media_asset
         (asset_id, content_id, kind, captured_at, tz_offset_min,
          capture_group_id, place_id, camera_device_id, width, height,
          duration_s, exif_json, archived_at, deleted_at, purge_at)
       VALUES (?, ?, 'photo', ?, NULL, NULL, NULL, NULL, 800, 600, NULL, NULL,
               NULL, NULL, NULL)`
    )
    .run(assetId, contentId, NOW);
  return assetId;
}

/** The ORIGIN is the only author there is. */
export function addAlbumPhoto(slot: ShareSlot, label: string): void {
  const assetId = insertPhoto(slot.origin, label);
  slot.origin.db.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, ?, ?)`
    )
    .run(uuidv7(), slot.album.albumId, assetId, slot.album.titles.length, NOW);
  slot.album.titles.push(label);
  slot.album.minted += 1;
}

function seedAlbum(seat: Seat, key: string): GrantAlbum {
  const albumId = uuidv7();
  seat.db.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, NULL, 0, ?)`
    )
    .run(albumId, seat.partyId, `Album ${key}`, NOW);
  return { albumId, titles: [], minted: 0 };
}

const TITLE_QUERY = `SELECT c.title AS title
     FROM core_collection_entry e
     JOIN media_asset a ON a.asset_id = e.target_id
     JOIN core_content_item c ON c.content_id = a.content_id
    WHERE e.collection_id = ? ORDER BY e.position, c.title`;

function titlesIn(ref: ShareVaultRef, collectionId: string): string[] {
  return (
    ref.vault.prepare(TITLE_QUERY).all(collectionId) as { title: string }[]
  ).map((row) => row.title);
}

export function originTitles(slot: ShareSlot): string[] {
  return titlesIn(slot.origin.db, slot.album.albumId);
}

export function projectedAlbumId(slot: ShareSlot): string | undefined {
  const row = slot.audience.db.vault
    .prepare(
      `SELECT target_id FROM core_share_origin
        WHERE target_type = 'core.collection' AND origin_vault_id = ?
          AND origin_item_id = ?`
    )
    .get(slot.origin.vaultId, slot.album.albumId) as
    | { target_id: string }
    | undefined;
  return row?.target_id;
}

/** `undefined` when the audience holds no projection. */
export function audienceTitles(slot: ShareSlot): string[] | undefined {
  const projected = projectedAlbumId(slot);
  return projected === undefined
    ? undefined
    : titlesIn(slot.audience.db, projected);
}

/** One is right; two mean a re-projection appended instead of replacing. */
export function projectionRowCount(slot: ShareSlot): number {
  return (
    slot.audience.db.vault
      .prepare(
        `SELECT COUNT(*) AS n FROM core_share_origin
          WHERE target_type = 'core.collection' AND origin_vault_id = ?
            AND origin_item_id = ?`
      )
      .get(slot.origin.vaultId, slot.album.albumId) as { n: number }
  ).n;
}

/** The divergence ruling G-view says the next pass must erase. */
export function tamperAudience(slot: ShareSlot, title: string): boolean {
  const projected = projectedAlbumId(slot);
  if (projected === undefined) return false;
  const changed = slot.audience.db.vault
    .prepare(
      `UPDATE core_content_item SET title = ?
        WHERE content_id IN (
          SELECT a.content_id FROM core_collection_entry e
            JOIN media_asset a ON a.asset_id = e.target_id
           WHERE e.collection_id = ?)`
    )
    .run(title, projected).changes;
  return Number(changed) > 0;
}

export function enrollPlaneAgent(seat: Seat): PlaneAgent {
  const agent = enrollAgent(seat.db, {
    name: `sim-agent-${seat.index}`,
    modelRef: "sim",
  });
  return {
    credential: agentCredential(seat, agent.agentId),
    agentPartyId: agent.partyId,
    consentGrantId: freshConsentGrant(seat, agent.partyId),
  };
}

function agentCredential(seat: Seat, agentId: string): Credential {
  const device = enrollDevice(
    seat.db,
    seat.partyId,
    `sim-agent-host-${seat.index}`
  );
  return {
    kind: "agent",
    agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
}

/** Called again after a revoke, so the program can keep parking. */
export function freshConsentGrant(seat: Seat, agentPartyId: string): string {
  return createGrant(seat.db, {
    granteePartyId: agentPartyId,
    purposeConceptId: seat.purposeConceptId,
    grantedByPartyId: seat.partyId,
    scopes: [{ schema: "tally", verbs: "read+act" }],
  });
}

/** One slot per ordered steward pair per album. Every slot starts with a live
 *  channel and one photograph, so the first `grant_fulfill` carries something
 *  real. */
export function buildGrantPlane(
  world: World,
  albumsPerPair: number
): GrantPlane {
  const seats = world.grants.map((grant) => grant.steward);
  const agents = new Map<number, PlaneAgent>();
  for (const seat of seats) {
    armConfirmGate(seat, PARKING_COMMAND);
    agents.set(seat.index, enrollPlaneAgent(seat));
  }
  const slots: ShareSlot[] = [];
  for (const origin of seats)
    for (const audience of seats) {
      if (origin.index === audience.index) continue;
      for (let n = 0; n < albumsPerPair; n += 1) {
        const key = `s${origin.index}->s${audience.index}#${n}`;
        const slot: ShareSlot = {
          key,
          origin,
          audience,
          audiencePartyId: uuidv7(),
          peerVaultId: `vault-sim-peer-${origin.index}-${audience.index}-${n}`,
          album: seedAlbum(origin, key),
          revoked: false,
          linked: true,
          tampered: false,
          everDelivered: false,
          reachLostAfterDelivery: false,
        };
        bindSlotChannel(slot, true);
        addAlbumPhoto(slot, `${key}-p0`);
        slots.push(slot);
      }
    }
  return { seats, slots, agents, parked: [] };
}

/** Real binding writes. The audience party is this slot's alone (isolation
 *  rule 1), so opening and severing it is invisible to the commons rail. */
export function bindSlotChannel(
  slot: ShareSlot,
  live: boolean
): "bound" | "conflict" | "self" | "revoked" | "absent" {
  const origin = slot.origin.db.vault;
  if (live) {
    const outcome = bindPartyToVault(origin, {
      partyId: slot.audiencePartyId,
      vaultId: slot.peerVaultId,
      linkedAt: NOW,
      displayName: `Audience ${slot.key}`,
    });
    slot.linked = outcome === "bound";
    return outcome;
  }
  const outcome = revokePartyVaultBinding(origin, {
    partyId: slot.audiencePartyId,
    vaultId: slot.peerVaultId,
    revokedAt: NOW,
  });
  slot.linked = false;
  return outcome;
}
