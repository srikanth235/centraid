/*
 * PHOTOS' SHARED READS, AS PAGES (#996 wave 4b, R8).
 *
 * Fourteen Photos screens ask for the same five sets. They were five
 * the truncation flag entity requests with a comment admitting what that
 * meant — "each takes the default window knowingly … the flag is the greppable
 * debt marker". The debt is paid here: each is a statement that names its
 * table, its columns and the order its keyset walks, and the walk states where
 * it stops.
 *
 * They stay in ONE module for the same reason they always did — fourteen
 * screens should not each re-declare the same read — and the hook goes with
 * them so a screen names the set it wants rather than assembling a read.
 */

import type { PageQuery } from "@centraid/core/page";

import type { ReplicaQueryState } from "../../kit/hooks/replica-query-state";
import { useSeatPages } from "../../kit/hooks/useSeatPages";

interface PhotoEntityRead {
  query: PageQuery;
  entity: string;
  rowIdColumn: string;
}

export const PHOTO_ENTITY_READS = {
  collections: {
    query: {
      name: "phone.photos.collections",
      select:
        "collection_id, owner_party_id, name, cover_content_id, " +
        "parent_collection_id, sort_order",
      from: "core_collection",
      order: {
        sortColumn: "sort_order",
        pkColumn: "collection_id",
        descending: false,
      },
    },
    entity: "core.collection",
    rowIdColumn: "collection_id",
  },
  // Only the entries that place an ASSET. A notebook's placements are Notes'
  // rows in the same table, and no Photos screen has ever drawn one.
  collectionEntries: {
    query: {
      name: "phone.photos.collection-entries",
      select:
        "entry_id, collection_id, target_type, target_id, position, added_at",
      from: "core_collection_entry",
      where: "target_type = ?",
      bind: ["media.asset"],
      order: {
        sortColumn: "collection_id",
        pkColumn: "entry_id",
        descending: false,
      },
    },
    entity: "core.collection_entry",
    rowIdColumn: "entry_id",
  },
  places: {
    query: {
      name: "phone.photos.places",
      select:
        "place_id, name, kind, geo_lat, geo_lng, geohash, tz, " +
        "parent_place_id",
      from: "core_place",
      order: { sortColumn: "name", pkColumn: "place_id", descending: false },
    },
    entity: "core.place",
    rowIdColumn: "place_id",
  },
  faceRegions: {
    query: {
      name: "phone.photos.face-regions",
      select:
        "region_id, asset_id, bbox_json, party_id, confidence, " +
        "confirmed_by_party_id, review_state",
      from: "media_face_region",
      order: {
        sortColumn: "asset_id",
        pkColumn: "region_id",
        descending: false,
      },
    },
    entity: "media.face_region",
    rowIdColumn: "region_id",
  },
  parties: {
    query: {
      name: "phone.photos.parties",
      select: "party_id, kind, display_name, sort_name, avatar_content_id",
      from: "core_party",
      order: {
        sortColumn: "sort_name",
        pkColumn: "party_id",
        descending: false,
      },
    },
    entity: "core.party",
    rowIdColumn: "party_id",
  },
  /**
   * WHO PRODUCED A FACE REGION (#1014, R13). Face review reported "where it
   * ran — on this device" for every proposal, including the ones the
   * GATEWAY's faces recipe made, which is every ambient one: the seat runs no
   * recogniser. Provenance is the only thing that actually knows, and it
   * replicates with the audit band, so the seat can read it.
   */
  faceProvenance: {
    query: {
      name: "phone.photos.face-provenance",
      select: "prov_id, entity_id, agent_kind, agent_id, occurred_at",
      from: "access_provenance",
      where: "entity_type = ?",
      bind: ["media.face_region"],
      order: {
        sortColumn: "occurred_at",
        pkColumn: "prov_id",
        descending: false,
      },
    },
    entity: "access.provenance",
    rowIdColumn: "prov_id",
  },
  // The enrichment tier for photos, which two screens ask about. One row per
  // domain — the table's whole point — so the walk is one page forever.
  enrichPolicies: {
    query: {
      name: "phone.photos.enrich-policies",
      select: "domain, tier, updated_at",
      from: "enrich_policy",
      order: { sortColumn: "domain", pkColumn: "domain", descending: false },
    },
    entity: "enrich.policy",
    rowIdColumn: "domain",
  },
} satisfies Record<string, PhotoEntityRead>;

/** One of Photos' five shared sets, walked over this phone's own copy. */
export function usePhotoEntity(
  name: keyof typeof PHOTO_ENTITY_READS
): ReplicaQueryState {
  const read: PhotoEntityRead = PHOTO_ENTITY_READS[name];
  return useSeatPages("photos", read.query, {
    entity: read.entity,
    rowIdColumn: read.rowIdColumn,
  });
}
