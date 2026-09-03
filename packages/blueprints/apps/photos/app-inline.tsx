import type { InlineAppModule } from "../inline-types.ts";
import { Root, PHOTOS_READ_TABLES_LIST } from "./app-root.tsx";
import { photosPendingProjection as pendingProjection } from "./pending-projection.ts";
import duplicatesQuery from "./queries/duplicates.ts";
import enrichmentStatusQuery from "./queries/enrichment-status.ts";
import facesQuery from "./queries/faces.ts";
import libraryQuery from "./queries/library.ts";
import peopleQuery from "./queries/people.ts";
import searchQueryModule from "./queries/search.ts";
import storageQuery from "./queries/storage.ts";

const photosInlineApp: InlineAppModule = {
  appId: "photos",
  pendingProjection,
  changeTables: PHOTOS_READ_TABLES_LIST,
  multiScope: true,
  queries: {
    library: { default: libraryQuery },
    search: { default: searchQueryModule },
    duplicates: { default: duplicatesQuery },
    "enrichment-status": { default: enrichmentStatusQuery },
    faces: { default: facesQuery },
    people: { default: peopleQuery },
    storage: { default: storageQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "photos",
    placeholder: "Ask your photos…",
    intro: "Ask me to find photos, make an album, or share a set.",
    suggest: [
      "Make an album of Saturday’s photos",
      "Find beach photos",
      "Share these with Dana",
    ],
  },
  Root,
};

export default photosInlineApp;
