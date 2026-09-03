import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import {
  PHOTOS_EMPTY_DUPLICATES,
  PHOTOS_EMPTY_FAVORITES,
  PHOTOS_SEARCH_PLACEHOLDER,
} from "./shared-copy.ts";
import { PEOPLE, PLACES, SEARCH, STORAGE } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

export {
  duplicatesLede,
  PHOTOS_ARCHIVE,
  PHOTOS_ARCHIVE_EMPTY,
  PHOTOS_EMPTY_DUPLICATES,
  PHOTOS_EMPTY_FAVORITES,
  PHOTOS_SEARCH_PLACEHOLDER,
  PHOTOS_UNARCHIVE,
  PLACE_UNNAMED,
  photosArchiveMoved,
  photosArchiveVerb,
} from "./shared-copy.ts";

export interface ShelfCopy {
  title: string;
  unit: string;
}

const SHELF_COPY: Readonly<Record<string, ShelfCopy>> = {
  [FAVORITES]: { title: "Favorites", unit: "photographs" },
  [ALBUMS]: { title: "Albums", unit: "albums" },
  [PLACES]: { title: "Places", unit: "places" },
  [PEOPLE]: { title: "People", unit: "people" },
  [DUPLICATES]: { title: "Duplicates", unit: "clusters" },
  [TRASH]: { title: "Trash", unit: "photographs" },
  [SEARCH]: { title: "Search", unit: "matches" },
  [STORAGE]: { title: "Storage and backup", unit: "photographs" },
};

const LIBRARY_COPY: ShelfCopy = { title: "Photos", unit: "photographs" };

export function shelfCopy(id: ShelfId): ShelfCopy {
  if (id === null) return LIBRARY_COPY;
  if (typeof id === "string" && id.startsWith("tag:")) {
    return { title: `#${id.slice(4)}`, unit: "photographs" };
  }
  if (typeof id === "string" && id.startsWith("memory:")) {
    return { title: "Memory", unit: "photographs" };
  }
  return SHELF_COPY[id] ?? LIBRARY_COPY;
}

const EMPTY_COPY: Readonly<Record<string, string>> = {
  [FAVORITES]: PHOTOS_EMPTY_FAVORITES,
  [ALBUMS]: "No albums yet — an album refers to a photograph where it lives.",
  [PLACES]:
    "No places yet — a photograph lands here once it carries where it was taken.",
  [PEOPLE]: "No people yet — faces are proposed on a photograph you open.",
  [DUPLICATES]: PHOTOS_EMPTY_DUPLICATES,
  [TRASH]: "Trash is empty.",
  [SEARCH]:
    "Search reaches titles, captions, people, places, things and album names across your whole library.",
};

const LIBRARY_EMPTY_BODY =
  "Photographs you bring in are held in your library; the originals stay on your gateway.";

export const EMPTY_TITLE = "Nothing here yet";

export function searchMissTitle(query: string): string {
  return `No matches for “${query}”.`;
}

export function emptyCopy(
  id: ShelfId,
  { query, inAlbum }: { query?: string; inAlbum?: boolean } = {}
): string {
  if (query) return searchMissTitle(query);
  if (id === null) return LIBRARY_EMPTY_BODY;
  if (typeof id === "string" && id.startsWith("tag:")) {
    return `No photographs tagged “${id.slice(4)}”.`;
  }
  if (inAlbum) return "Nothing in this album yet.";
  return EMPTY_COPY[id] ?? "Nothing here yet.";
}

export const TRASH_NOTE =
  "Deleted photographs are purged after 30 days; restoring returns them to the day they were taken.";

export const EMPTY_TRASH_COPY = {
  control: "Empty trash",
  question: (count: number) =>
    `Delete ${count} ${count === 1 ? "photograph" : "photographs"} forever?`,
  detail: (count: number, bytes: string) =>
    `This cannot be undone. ${count === 1 ? "It leaves" : "They leave"} your library now — with ${count === 1 ? "its" : "their"} captions, faces, tags and album membership — and the ${bytes} ${count === 1 ? "it holds is" : "they hold are"} freed shortly afterwards. Restore will not bring ${count === 1 ? "it" : "them"} back.`,
  confirm: (count: number) => `Delete ${count} forever`,
  cancel: "Keep them",
  readOnly: (label: string) =>
    `${label} is view-only — nothing deletes from it.`,
} as const;

export function emptyOffersImport(
  id: ShelfId,
  { query }: { query?: string } = {}
): boolean {
  if (query) return false;
  return id === null || id === ALBUMS;
}

export function peoplePendingNote(unmatchedCount: number | null): string {
  if (unmatchedCount === null) {
    return "Faces are not matched to anyone yet — face review proposes them one at a time.";
  }
  const verb = unmatchedCount === 1 ? "face is" : "faces are";
  return `${unmatchedCount} ${verb} not matched to anyone — face review proposes them one at a time.`;
}

export function peopleConfirmedByNote(
  confirmedBy: ReadonlyArray<{ party_id: string; name: string | null }>
): string | null {
  if (confirmedBy.length < 2) return null;
  const names = confirmedBy.map((party) => party.name ?? "someone else");
  const last = names[names.length - 1];
  const head = names.slice(0, -1).join(", ");
  return `Confirmed by ${head} and ${last} — separately, and they stay separate.`;
}

export const DOWNLOAD_PRIMARY = "Download";
export function downloadPrimaryTitle(scopeLabel: string): string {
  return `You may download from ${scopeLabel}`;
}

export function personEmptyCopy(name: string): string {
  return `No photographs confirmed as ${name} yet.`;
}

export const OFFLINE_COPY = {
  status:
    "Offline · meaning renders from the local replica; bytes stay on the gateway",
  banner:
    "Gateway unreachable — meaning reads from this device, uncached photographs show shape and colour.",
  retry: "Retry",
  label: "Offline",
} as const;

export const EMPTY_ACTIONS = {
  import: "Import photographs",
  camera: "Take a photograph",
} as const;

export const PERMISSION_COPY = {
  headline: "Photos has no access yet",
  lede: "Photos reads your library to show it back to you — nothing has been read yet.",
  missingLabel: "What is missing",
  missingFallback:
    "The owner has not approved the reads this app asked for — the list is in their settings.",
  facts: [
    { label: "What Photos can see right now", value: "nothing" },
    {
      label: "What happens if access comes back",
      value:
        "your timeline is exactly as it was, including the tile size you chose",
    },
  ],
} as const;

export const STORAGE_COPY = {
  lede: "What your photographs cost, and where their bytes currently are.",
  spaceHead: "Space",
  spaceMeta: (shown: number, bytes: string) =>
    `${shown} ${shown === 1 ? "photograph" : "photographs"} · ${bytes}`,
  windowNote: (shown: number) =>
    `These numbers cover the ${shown} photographs loaded here — Show more on the timeline reaches older ones.`,
  wholeNote: "These numbers cover your whole library.",
  sizeAbsent:
    "No size was recorded for these, so the total below counts only the ones that carry one.",
  healthHead: "Backup",
  healthPending: "Reading what the gateway last counted…",
  healthMeta: {
    unknown: "not counted yet",
    missing: "attention",
    "only-here": "not backed up",
    waiting: "pending",
    held: "healthy",
  },
  healthLine: {
    unknown:
      "Nobody has counted your originals yet — that answer comes from the gateway.",
    missing: (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} recorded in your library but their bytes are in neither place — the gateway's storage screen is where that is investigated.`,
    "only-here": (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} held on the gateway and nowhere else. A second copy is what makes them safe.`,
    waiting: (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} queued to be copied elsewhere.`,
    held: "Every original the gateway counted is held in more than one place.",
  },
  checkedAt: (when: string) => `Counted ${when}.`,
  unreadScopes: (labels: readonly string[]) =>
    `${labels.join(" and ")} did not answer, so the numbers below leave ${labels.length === 1 ? "it" : "them"} out.`,
  uncountedScopes: (labels: readonly string[]) =>
    `${labels.join(" and ")} ${labels.length === 1 ? "has" : "have"} not been counted yet and ${labels.length === 1 ? "is" : "are"} not in the numbers below.`,

  custodyHead: "Where the originals are",
  custodyRow: {
    replicated: "In your library and copied elsewhere",
    "remote-only": "On the gateway only, fetched when you ask",
    "local-only": "On the gateway and nowhere else",
    "pending-offsite": "Queued to be copied elsewhere",
    missing: "In neither place",
  },
  libraryMeta: (count: number, bytes: string) =>
    `${count} ${count === 1 ? "original" : "originals"} · ${bytes}`,

  freeUpHead: "Free up space",
  freeUpTitle: (bytes: string) => `${bytes} could be released`,
  freeUpBody: (count: number) =>
    `Full-quality originals for ${count} ${count === 1 ? "photograph" : "photographs"} are held here and proved to be held elsewhere, so the local copy could go.`,
  freeUpWhere:
    "Releasing them runs on the gateway, with the storage settings that own its disk.",
  freeUpUnproven: (count: number, bytes: string) =>
    `${count} ${count === 1 ? "original" : "originals"} · ${bytes} held here have no proved copy elsewhere, so they are never offered for release.`,
  freeUpNothing:
    "No original held here has a proved copy elsewhere, so nothing can be released.",

  trashHead: "Freeing space",
  trashNote: "Emptying the trash is the one thing here that frees bytes.",
  trashEmpty: "Nothing is in the trash, so there is nothing to free.",
} as const;

export const SEARCH_EXAMPLES: readonly string[] = [
  "ana at the coast",
  "videos from June",
  "photographs with no place",
  "Pemberton kitchen",
  "scans from the solicitor",
];

export const SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search the whole library",
    body: "Not only what is loaded here — try one of these.",
  },
  searching: {
    lead: "Searching your whole library.",
    trail: (count: number) =>
      `${count === 1 ? "match" : "matches"} from what is loaded on this device so far.`,
  },
  miss: {
    eyebrow: "No results",
    title: (query: string) => `Nothing matches “${query}”`,
    body: "Nothing in captions, people, places, things or album names.",
    clear: "Clear the query",
  },
  unreachable: {
    eyebrow: "Cannot reach the gateway",
    title: "Search needs the gateway",
    body: "Nothing below has been searched — it is the match over photographs already on this device.",
    retry: "Retry",
    facts: [
      {
        label: "what still works",
        value: "browsing, albums, favorites, captions",
      },
      { label: "what does not", value: "search, people, places" },
    ],
  },
  placeholder: PHOTOS_SEARCH_PLACEHOLDER,
} as const;
