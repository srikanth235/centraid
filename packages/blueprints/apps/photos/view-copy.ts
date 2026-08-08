// Every string a Photos view says about ITSELF: the app-bar title, what the
// count counts, and how each shelf is empty on its own terms (v4 handoff §5,
// §14). Extracted from the orchestrator because copy is a product decision
// that changes on its own schedule, and because "each shelf is empty on its
// own terms" is a table, not a chain of ternaries in a render function.
//
// The copy here is FINAL — the handoff's strings, verbatim. It never names the
// storage noun for a scope: what a member reads for a vault is `scope.label`,
// which the shell owns and the owner may rename.
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import { PEOPLE, PLACES, SEARCH, SHARING, STORAGE } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

// The two strings native also renders live in an import-free leaf
// (`shared-copy.ts`) so the mobile TypeScript project can read them without
// pulling in this module's explicit-`.ts` graph. They are re-exported here so
// every web caller keeps importing them from the module it already knows.
export { duplicatesLede, PLACE_UNNAMED } from "./shared-copy.ts";

/** What a shelf calls itself in the frame's app bar, and what its count
 *  counts. `unit` is plural; frame.tsx singularises it for a count of one. */
export interface ShelfCopy {
  title: string;
  unit: string;
}

const SHELF_COPY: Readonly<Record<string, ShelfCopy>> = {
  [SHARING]: { title: "Sharing", unit: "photographs" },
  [FAVORITES]: { title: "Favorites", unit: "photographs" },
  [ALBUMS]: { title: "Albums", unit: "albums" },
  [PLACES]: { title: "Places", unit: "places" },
  [PEOPLE]: { title: "People", unit: "people" },
  [DUPLICATES]: { title: "Duplicates", unit: "clusters" },
  [TRASH]: { title: "Trash", unit: "photographs" },
  [SEARCH]: { title: "Search", unit: "matches" },
  // "Storage and backup", not "Storage" (proto 4972): backup health, the
  // policy switches and freeing space are the same screen and the same
  // question — where the bytes are and whether a second machine has them.
  // A bar that said only "Storage" named half of what it opens.
  [STORAGE]: { title: "Storage and backup", unit: "photographs" },
};

const LIBRARY_COPY: ShelfCopy = { title: "Photos", unit: "photographs" };

/** The bar's title and unit for a shelf. An album's own id is in no table —
 *  album detail carries the album's title, which the caller supplies. */
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

/** How each shelf is empty on its own terms (§14). A shelf that is empty
 *  because the member has not imported anything yet says something different
 *  from one that is empty because nothing matched. */
const EMPTY_COPY: Readonly<Record<string, string>> = {
  [SHARING]:
    "Nothing is in Sharing yet. A photograph is shared because it sits here, and it stops being shared the moment it leaves.",
  [FAVORITES]: "No favorites yet — tap the heart on any photograph.",
  [ALBUMS]:
    "No albums yet. An album refers to a photograph where it lives; it never moves or copies anything.",
  [PLACES]:
    "No places yet — a photograph lands here once it carries where it was taken.",
  [PEOPLE]:
    "No people yet. Faces are proposed on a photograph you open, and a name is only ever yours to confirm.",
  [DUPLICATES]: "No near-identical clusters in your library.",
  [TRASH]: "Trash is empty.",
  [SEARCH]:
    "Search reaches titles, captions, people, places, things and album names across your whole library.",
};

/**
 * A new library, in the reading register (§14, proto 4407).
 *
 * ONE WORD DIVERGES FROM THE HANDOFF, deliberately. The prototype writes
 * "held in this vault"; this app may never print the storage noun for a scope
 * (issue #599 — what a member reads for a scope is `scope.label`, which the
 * owner is free to rename, and `src/photos-vocabulary.test.ts` enforces it).
 * "your library" is this app's own word for the same place and is what every
 * other line here already calls it. The sentence that carries the meaning —
 * where the originals stay, and that nothing is copied anywhere unasked — is
 * verbatim, and it is the load-bearing half.
 */
const LIBRARY_EMPTY_BODY =
  "Photographs you bring in are held in your library. The originals stay on your gateway and nothing is copied anywhere you have not asked for.";

/**
 * The empty block's TITLE (§14, proto 4406): display serif, one line. It is
 * the same line on every shelf on purpose — what makes a shelf empty on its
 * own terms is the paragraph under it (`emptyCopy`), not a second headline
 * per shelf, and a 31px display line is a headline, not a sentence.
 */
export const EMPTY_TITLE = "Nothing here yet";

/** The one case where the title is about what the member just did rather
 *  than about the shelf, so it wins the headline (§9). */
export function searchMissTitle(query: string): string {
  return `No matches for “${query}”.`;
}

/**
 * The empty-state PARAGRAPH for the current view — the reading register, under
 * `EMPTY_TITLE`. `query` and `album` are the two cases that are about what the
 * member just did rather than about the shelf, so they win.
 *
 * The library's paragraph is §14's load-bearing sentence: an empty library is
 * the one moment a member is deciding whether to hand this app their
 * photographs, and it is the moment the app owes them where the bytes go. It
 * used to say "your library starts with the first import", which describes the
 * mechanism and answers nothing.
 */
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

/**
 * The Trash shelf's own note (§5, proto 4445), printed once above the first
 * month — never per-photograph, since every trashed row shares the same
 * 30-day grace window and the same restore behaviour.
 */
export const TRASH_NOTE =
  "Deleted photographs stay here for 30 days, then they are purged. Anything restored goes back to the day it was taken.";

/**
 * Emptying the trash (proto:4800-4803), in words. This is the app's only
 * permanent destruction, so the confirmation says three things BEFORE it can
 * happen — HOW MANY, WHAT ELSE goes with them, and that it cannot be undone —
 * and it says them in the confirm itself rather than in a tooltip or a
 * follow-up. `Restore will not bring them back` is deliberate: Restore is the
 * control a member reaches for when they regret a deletion, and the sentence
 * that matters is the one that names it.
 */
export const EMPTY_TRASH_COPY = {
  control: "Empty trash",
  question: (count: number) =>
    `Delete ${count} ${count === 1 ? "photograph" : "photographs"} forever?`,
  detail: (count: number, bytes: string) =>
    `This cannot be undone. ${count === 1 ? "It leaves" : "They leave"} your library now — with ${count === 1 ? "its" : "their"} captions, faces, tags and album membership — and the ${bytes} ${count === 1 ? "it holds is" : "they hold are"} freed shortly afterwards. Restore will not bring ${count === 1 ? "it" : "them"} back.`,
  confirm: (count: number) => `Delete ${count} forever`,
  cancel: "Keep them",
  /** Why the control cannot fire, when it cannot — stated, never a grey box
   *  with nothing to read (§18). */
  readOnly: (label: string) => `You can view ${label} but not delete from it.`,
} as const;

/** Does the empty state offer Import? Only where importing would put a
 *  photograph in front of the member — not in Trash, not in a search miss. */
export function emptyOffersImport(
  id: ShelfId,
  { query }: { query?: string } = {}
): boolean {
  if (query) return false;
  return id === null || id === ALBUMS;
}

/**
 * What the People shelf says about faces it has NOT been told a name for
 * (§5, §8, proto 4433), verbatim except the live count substituted for the
 * prototype's fixed "54" — a count that never changed would eventually lie.
 * `null` while that count has not loaded yet: the note omits the number
 * rather than claiming a zero it has not actually read (§14).
 */
export function peoplePendingNote(unmatchedCount: number | null): string {
  if (unmatchedCount === null) {
    return "Faces are not matched to anyone yet. Face review proposes them one at a time, and nothing is named until you name it.";
  }
  const verb = unmatchedCount === 1 ? "face is" : "faces are";
  return `${unmatchedCount} ${verb} not matched to anyone. Face review proposes them one at a time, and nothing is named until you name it.`;
}

/**
 * WHO AGREED THIS IS THEM (issue #712 P6b). A person's group is assembled
 * from confirmations, and in a shared library those confirmations can come
 * from more than one member — `media_face_region` records the subject
 * (`party_id`) and the answerer (`confirmed_by_party_id`) as two separate
 * columns, so a group that spans two members is a fact the schema already
 * carries rather than a merge anyone has to perform.
 *
 * SAID ONLY WHEN IT IS NEWS. One confirmer is the ordinary case and needs no
 * caption — attribution on every card would be noise that teaches a reader to
 * stop reading it. `null` there, and a sentence only when the group genuinely
 * spans more than one answerer. A confirmer this read could not name is
 * counted, never invented: it reads as "someone else", which is exactly what
 * is known about them.
 */
export function peopleConfirmedByNote(
  confirmedBy: ReadonlyArray<{ party_id: string; name: string | null }>
): string | null {
  if (confirmedBy.length < 2) return null;
  const names = confirmedBy.map((party) => party.name ?? "someone else");
  const last = names[names.length - 1];
  const head = names.slice(0, -1).join(", ");
  return `Confirmed by ${head} and ${last} — separately, and they stay separate.`;
}

/**
 * THE READ-ONLY SURFACE'S APP-BAR PRIMARY (proto 4800-4801). A grant that
 * reads "read and download" keeps a primary — it BECOMES `Download` — rather
 * than losing one: a surface with its only filled control removed reads as a
 * surface with nothing to do on it, which is not what the grant says.
 *
 * The prototype's own title names the owner ("Tom's library"); this one names
 * the scope by the label the shell publishes, which its owner may rename, and
 * never by a storage noun (issue #599).
 */
export const DOWNLOAD_PRIMARY = "Download";
export function downloadPrimaryTitle(scopeLabel: string): string {
  return `You may download from ${scopeLabel}`;
}

/** The empty line for one confirmed person's own timeline (§5). */
export function personEmptyCopy(name: string): string {
  return `No photographs confirmed as ${name} yet.`;
}

/**
 * OFFLINE (§14, proto 4867-4873, 4919). The gateway being out of reach is a
 * STATE the product is designed for, not a failure it apologises for once in a
 * status line — which is what this app used to do, with an invented sentence
 * ("Couldn't reach your library — retrying when you come back") that named
 * neither what still works nor why the grid looks the way it does.
 *
 * `README.md` §14 is explicit: "A grey mosaic with no explanation is a bug."
 * So the banner says what is still true (all the meaning is here) and what is
 * not (the bytes), and it takes a `--net` BORDER — never a fill, never an icon
 * and never a dimmed container.
 */
export const OFFLINE_COPY = {
  /** The one status line, verbatim (proto 3951). */
  status:
    "Offline · meaning renders from the local replica; bytes stay on the gateway",
  /** The bordered banner's body, verbatim (proto 4871). */
  banner:
    "The gateway is unreachable. Everything you see here is read from this device — captions, dates, albums, people. Photographs whose bytes are not cached show their shape and their colour instead.",
  /** Its one outlined control (proto 4872). */
  retry: "Retry",
  /** What the banner is called to a screen reader. */
  label: "Offline",
} as const;

/** The empty block's two actions (§14, proto 4407). `Take a photograph` is
 *  offered where a camera is a real way in — the phone (§15's Import row). */
export const EMPTY_ACTIONS = {
  import: "Import photographs",
  camera: "Take a photograph",
} as const;

/**
 * The permission screen (§13). An ungranted or revoked grant is a designed
 * screen, not an error strip: a headline, one paragraph, then what is true
 * right now — what is missing, what Photos can see meanwhile (nothing), and
 * what happens if the grant comes back.
 */
export const PERMISSION_COPY = {
  headline: "Photos has no access yet",
  lede: "Photos reads your library to show it back to you. Until the owner approves that, this screen is all there is — nothing has been read, and nothing has been sent anywhere.",
  missingLabel: "What is missing",
  /** The reason the host handed back, or an honest stand-in for none. */
  missingFallback:
    "The owner has not approved the reads this app asked for. The exact list is in the owner’s settings, beside every other app.",
  facts: [
    { label: "What Photos can see right now", value: "nothing" },
    {
      label: "What happens if access comes back",
      value:
        "your timeline is exactly as it was, including the tile size you chose",
    },
  ],
} as const;

/**
 * The Storage view (§12). Every number on that screen is read from the rows
 * the app already holds; these are the words around them, plus the honest
 * absent copy for the numbers this surface cannot know.
 */
export const STORAGE_COPY = {
  lede: "What your photographs cost, and where their bytes currently are.",
  /**
   * The section this screen leads with. Its numbers ride the head's META
   * (proto 4364, `sectionBlock('Space','184.2 GB on this device')`) — the
   * prototype's Storage screen has no figure display at all. Two 31px numerals
   * were this app answering a question ("how big is my library?") louder than
   * the questions the screen is actually for: is it backed up, and what would
   * freeing space cost me.
   */
  spaceHead: "Space",
  /** The head's meta — read off the rows, in the numeric register. */
  spaceMeta: (shown: number, bytes: string) =>
    `${shown} ${shown === 1 ? "photograph" : "photographs"} · ${bytes}`,
  windowNote: (shown: number) =>
    `These numbers cover the ${shown} photographs loaded here. Older ones are still in your library — open Show more on the timeline to reach them, and this count grows with it.`,
  wholeNote: "These numbers cover your whole library.",
  sizeAbsent:
    "No size was recorded for these, so the total below counts only the ones that carry one.",
  /**
   * Health (proto 4351-4355, the three `rowsBlock` states). Three of the
   * prototype's four claims survive; the fourth does not, and its absence is
   * deliberate. "The office gateway has refused three runs" needs an attempt
   * count and an error the custody rollup does not carry, so this surface has
   * no failing verdict at all rather than a guessed one. What it CAN prove is
   * worse and rarer: bytes in neither place.
   */
  healthHead: "Backup",
  /** Before the read lands. NOT the same sentence as "the gateway has never
   *  counted": one is this screen not knowing yet, the other is an answer. */
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
      "Nobody has counted your originals yet. That answer comes from the gateway, and this screen will not guess it.",
    missing: (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} recorded in your library but their bytes are in neither place. Nothing here can restore them; the gateway's own storage screen is where that is investigated.`,
    "only-here": (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} held on the gateway and nowhere else. A second copy is what makes them safe.`,
    waiting: (count: number) =>
      `${count} ${count === 1 ? "original is" : "originals are"} queued to be copied elsewhere. Nothing has failed.`,
    held: "Every original the gateway counted is held in more than one place.",
  },
  /** The as-of stamp. The rollup says when it was computed; it is never "now". */
  checkedAt: (when: string) => `Counted ${when}.`,
  /** Scopes that could not answer make every total below a floor — say which. */
  unreadScopes: (labels: readonly string[]) =>
    `${labels.join(" and ")} did not answer, so the numbers below leave ${labels.length === 1 ? "it" : "them"} out.`,
  uncountedScopes: (labels: readonly string[]) =>
    `${labels.join(" and ")} ${labels.length === 1 ? "has" : "have"} not been counted yet and ${labels.length === 1 ? "is" : "are"} not in the numbers below.`,

  /**
   * Where the originals are (proto 4372-4377, `sectionBlock('Originals that
   * live somewhere else')`). The prototype's three rows split that number by
   * CAUSE — offloaded by the operating system, never copied here, reached over
   * a metered connection. None of those three distinctions exists in the
   * custody projection, so this renders the one split it can prove.
   */
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

  /**
   * Free up space (proto 4364-4371, the `panelBlock` under `sectionBlock
   * ('Space')`). The panel states what would go and what would remain — and it
   * only ever describes ORIGINALS the projection proved are held somewhere
   * else. There is no control: nothing in this app's granted command surface
   * releases local bytes, and a button that did nothing would be worse than
   * the sentence that says where it does happen.
   */
  freeUpHead: "Free up space",
  freeUpTitle: (bytes: string) => `${bytes} could be released`,
  freeUpBody: (count: number) =>
    `Full-quality originals for ${count} ${count === 1 ? "photograph" : "photographs"} are held here and also proved to be held elsewhere, so removing the local copy would lose nothing. Everything stays browsable either way: the timeline, captions, albums and people are unchanged, and a full-quality copy is fetched when you ask for one.`,
  freeUpWhere:
    "Releasing them is not done from here — it runs on the gateway, with the storage settings that own its disk.",
  freeUpUnproven: (count: number, bytes: string) =>
    `${count} ${count === 1 ? "original" : "originals"} · ${bytes} held here have no proved copy anywhere else. They are never offered for release, whatever the disk is doing.`,
  freeUpNothing:
    "No original held here has a proved copy elsewhere, so there is nothing that could be released without becoming the last copy of something.",

  trashHead: "Freeing space",
  trashNote:
    "Emptying the trash is the one thing here that frees bytes. What stays is browsable either way: meaning lives in your library, and fetching an original is always an explicit choice.",
  trashEmpty: "Nothing is in the trash, so there is nothing to free.",
} as const;

/** The five real example queries the empty search panel offers (§9, ~4269).
 *  Verbatim from the handoff — a member can type any of these back exactly. */
export const SEARCH_EXAMPLES: readonly string[] = [
  "ana at the coast",
  "videos from June",
  "photographs with no place",
  "Pemberton kitchen",
  "scans from the solicitor",
];

/** The Search shelf's four states (§9, ~4256-4276), verbatim except one
 *  deviation: the handoff's unreachable eyebrow/title name "the vault", which
 *  `src/photos-vocabulary.test.ts` (issue #599) forbids in Photos copy. The
 *  same fact — the index lives on the gateway and could not be reached —
 *  survives without the word. */
export const SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search the whole library",
    body: "Not the photographs that happen to be loaded. Try one of these.",
  },
  // Moved here from SearchShelf.tsx's own JSX (issue #712 S1), alongside
  // `unreachable.body` below, so `_shared/SearchScaffold.tsx` can source
  // every state's copy from this one object.
  searching: {
    lead: "Searching your whole library.",
    trail: (count: number) =>
      `${count === 1 ? "match" : "matches"} from what is loaded on this device so far.`,
  },
  miss: {
    eyebrow: "No results",
    // NOT `searchMissTitle` (below): that helper is shared with
    // view-state.ts's generic query-miss overlay
    // (`src/photos-shelves-v4.test.ts` asserts its exact wording), so this
    // shelf's own title lives here instead of changing shared behavior.
    title: (query: string) => `Nothing matches “${query}”`,
    // ALIGNED WITH MOBILE (issue #711 reconciliation), not the earlier
    // "Titles, captions, people, places, things and album names were all
    // searched.": mobile's search reaches a replica with no tag/label entity
    // at all, so its honest miss body is "Nothing in captions, people,
    // places or album names." This app's `search-groups.ts` genuinely
    // matches free-form tags (`core.tag_item`) against the query, so this
    // client keeps "things" — the one word that is true here and false
    // there — and otherwise uses mobile's exact words, so the two surfaces
    // teach the same fact about the same control everywhere they agree.
    body: "Nothing in captions, people, places, things or album names.",
    clear: "Clear the query",
  },
  unreachable: {
    // Deliberate deviation from the handoff's "Cannot reach the vault" (§599).
    eyebrow: "Cannot reach the gateway",
    title: "Search needs the gateway",
    // Moved here from SearchShelf.tsx's own JSX (issue #712 S1) when that
    // component started sourcing its unreachable panel from the shared
    // `SearchScaffold` — copy now lives with the rest of SEARCH_COPY instead
    // of half in this object and half inline in the component.
    body: "It lives on the gateway. Nothing below has been searched for you — what you can see is the match over the photographs already loaded on this device, which is a smaller question than the one you asked.",
    retry: "Retry",
    facts: [
      {
        label: "what still works",
        value: "browsing, albums, favorites, captions",
      },
      { label: "what does not", value: "search, people, places" },
    ],
  },
  placeholder: "Search photographs, people, places, albums",
} as const;
