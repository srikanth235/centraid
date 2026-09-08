// Photos' whole-entity read requests, as data (#922 0a).
//
// Fourteen Photos screens ask for the same five entities, and each one used to
// re-declare its request inside a `useMemo(..., [])` — a hook whose only job
// was to give a constant a stable identity, written out once per screen. The
// requests never depended on anything, so they are module constants here: the
// identity `useReplicaQuery` keys its effect on is now the module's, which is
// as stable as a value gets, and the five declarations exist once.
//
// Each takes the default window knowingly. Photos' library is bounded by the
// timeline engine, not by these decorations — they are collections, places,
// face regions and parties, all small beside the asset set — and a window that
// ever fills says so on the status line rather than silently. E2 gives each of
// them a declared window; until then the flag is the greppable debt marker.

import type { NativeReadRequest } from "../../lib/replica/native-session";

export const PHOTO_ENTITY_READS = {
  collections: { acceptTruncation: true, entity: "core.collection" },
  collectionEntries: {
    acceptTruncation: true,
    entity: "core.collection_entry",
  },
  places: { acceptTruncation: true, entity: "core.place" },
  faceRegions: { acceptTruncation: true, entity: "media.face_region" },
  parties: { acceptTruncation: true, entity: "core.party" },
} satisfies Record<string, NativeReadRequest>;
