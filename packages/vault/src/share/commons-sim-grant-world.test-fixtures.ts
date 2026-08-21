// Physical world for the SHARE-GRANT half of the Commons simulator (issue
// #839, gaps G1/G2/G3). The #731 simulator drives the commons rail; this half
// hangs the grant plane (`grant/grant-store.ts`, `grant/fulfillment.ts`) and
// the durable parked store (`replica/parked.ts`) off the SAME real on-disk
// vaults, so one seeded program interleaves both planes over one world.
//
// Two isolation rules make that safe, and both are load-bearing:
//
//   1. THE AUDIENCE IS A SYNTHETIC PARTY ON A SYNTHETIC PEER VAULT ID. The
//      commons rail resolves a member from a vault id with a single-row
//      `SELECT party_id FROM share_party_vault_binding WHERE vault_id = ?`
//      (commons-bootstrap.ts, `exportCommonsSyncFrame`). Binding a SECOND
//      live party to a seat's own vault id would make that lookup ambiguous
//      and break the commons rail for reasons that have nothing to do with
//      grants. So a slot's audience is its own party, bound to its own peer
//      vault id, and `seatRefFor` maps that id back to the real seat.
//   2. PLANE SEATS ARE STEWARD SEATS ONLY. `stale_restore` rewinds a whole
//      SQLite file, which would resurrect a projection a revocation had
//      hard-deleted — a peer rolling back under the origin's feet, outside
//      what the grant plane promises. Stewards are never rewound (see
//      `replicaOnlySeats`), so the plane lives on them.
//
// The schedule and the grant oracle live in `commons-sim-grant.test-fixtures.ts`.

import { createGrant, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { ShareFulfillmentState } from "../grant/grant-store.js";
import type { Credential } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import type { Seat, World } from "./commons-sim-world.test-fixtures.js";
import { NOW, armConfirmGate } from "./commons-sim-world.test-fixtures.js";
import {
  bindPartyToVault,
  revokePartyVaultBinding,
} from "./party-vault-binding.js";
import type { ShareVaultRef } from "./placement.js";

/** The one command a plane seat marks loud-on-purpose so a non-owner caller
 *  parks on it. Deliberately OUTSIDE the commons routing table (no `group_id`
 *  / `expense_id` key), so parking a call can never disturb the tally oracle. */
export const PARKING_COMMAND = "tally.add_friend";

/** The subject every slot shares: an album, the canonical `view` container. */
export interface GrantAlbum {
  albumId: string;
  /** Titles the ORIGIN holds, in album order — the model's copy of truth. */
  titles: string[];
  /** Monotonic label counter, so every photo's bytes are its own. */
  minted: number;
}

/** One (origin, audience, subject) triple and its whole grant lifecycle. */
export interface ShareSlot {
  key: string;
  origin: Seat;
  audience: Seat;
  /** The audience person, known only to the origin vault. */
  audiencePartyId: string;
  /** The peer vault id this slot delivers into. See isolation rule 1. */
  peerVaultId: string;
  album: GrantAlbum;
  grantId?: string;
  /** Model of the store's row: standing until revoked, and never re-granted. */
  revoked: boolean;
  /** Model of `share_fulfillment.state`; absent until a row exists. */
  fulfillment?: ShareFulfillmentState;
  /** True while the model believes the party↔vault binding is live. */
  linked: boolean;
  /** The audience was edited behind the origin's back; a delivered pass heals it. */
  tampered: boolean;
  /** The grant was delivered at least once — a non-vacuity witness. */
  everDelivered: boolean;
}

/** One durable parked payload the gateway minted, and how it ended. */
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

/** Resolve a peer vault id to the seat behind it, or `undefined` for "this
 *  host cannot reach that vault right now" — the fact `fulfillShareGrant` and
 *  `propagateShareGrantRevocation` branch on. */
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
          duration_s, exif_json, favorite, archived_at, deleted_at, purge_at)
       VALUES (?, ?, 'photo', ?, NULL, NULL, NULL, NULL, 800, 600, NULL, NULL,
               0, NULL, NULL, NULL)`
    )
    .run(assetId, contentId, NOW);
  return assetId;
}

/** Add one photograph to an album at the ORIGIN — the only author there is. */
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

/** What the ORIGIN's album actually holds right now. */
export function originTitles(slot: ShareSlot): string[] {
  return titlesIn(slot.origin.db, slot.album.albumId);
}

/** The audience-side id of the projection of this slot's album, if any. */
export function projectedAlbumId(slot: ShareSlot): string | undefined {
  const row = slot.audience.db.vault
    .prepare(
      `SELECT item_id FROM core_share_origin
        WHERE item_type = 'core.collection' AND origin_vault_id = ?
          AND origin_item_id = ?`
    )
    .get(slot.origin.vaultId, slot.album.albumId) as
    | { item_id: string }
    | undefined;
  return row?.item_id;
}

/** What the AUDIENCE holds, or `undefined` when it holds no projection. */
export function audienceTitles(slot: ShareSlot): string[] | undefined {
  const projected = projectedAlbumId(slot);
  return projected === undefined
    ? undefined
    : titlesIn(slot.audience.db, projected);
}

/** How many provenance rows the audience keeps for this slot's subject. One
 *  is right; two would mean a re-projection appended instead of replacing. */
export function projectionRowCount(slot: ShareSlot): number {
  return (
    slot.audience.db.vault
      .prepare(
        `SELECT COUNT(*) AS n FROM core_share_origin
          WHERE item_type = 'core.collection' AND origin_vault_id = ?
            AND origin_item_id = ?`
      )
      .get(slot.origin.vaultId, slot.album.albumId) as { n: number }
  ).n;
}

/** Overwrite a projected caption in the AUDIENCE vault: the divergence the
 *  re-projection doctrine (ruling G-view) says the next pass must erase. */
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

/** Enroll the non-owner caller whose invocations park, plus its consent grant. */
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
  const device = enrollDevice(seat.db, seat.partyId, `sim-agent-host-${seat.index}`);
  return {
    kind: "agent",
    agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
}

/** A new standing consent grant for the plane agent. Called again after the
 *  owner revokes one, so the program can keep parking afterwards. */
export function freshConsentGrant(seat: Seat, agentPartyId: string): string {
  return createGrant(seat.db, {
    granteePartyId: agentPartyId,
    purposeConceptId: seat.purposeConceptId,
    grantedByPartyId: seat.partyId,
    scopes: [{ schema: "tally", verbs: "read+act" }],
  });
}

/**
 * Build the plane over the world's steward seats: one agent per seat with the
 * parking command armed, and one slot per ordered steward pair per album.
 * Every slot starts with a live channel and a one-photograph album, so the
 * first `grant_fulfill` has something real to carry.
 */
export function buildGrantPlane(world: World, albumsPerPair: number): GrantPlane {
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
        };
        bindSlotChannel(slot, true);
        addAlbumPhoto(slot, `${key}-p0`);
        slots.push(slot);
      }
    }
  return { seats, slots, agents, parked: [] };
}

/**
 * Open or sever the slot's channel through the real binding writes. The
 * audience party is this slot's alone (isolation rule 1), so lighting it up
 * and putting it out is invisible to the commons rail.
 */
export function bindSlotChannel(slot: ShareSlot, live: boolean): "bound" | "conflict" | "revoked" | "absent" {
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
