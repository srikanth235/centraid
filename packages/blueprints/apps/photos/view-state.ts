// What the view is ALLOWED to say about itself, given what has actually been
// read (v4 handoff §14, README §14). Pure and DOM-free on purpose: every rule
// in this file is one the app got WRONG by expressing it as a condition inline
// in a render function, where it could not be read and could not be tested.
//
// Three rules live here, and each one exists because its absence made the app
// tell a member something untrue:
//
//  1. NOTHING IS EMPTY UNTIL A READ HAS LANDED. `visibleAssets()` is `[]`
//     before the first read resolves, so gating the empty state on a count
//     alone told a member with 6,214 photographs that they had none. The empty
//     state is gated on `loaded` — a read that came back — and until then the
//     view paints `--skel` at the packed geometry instead (components/
//     LoadingGrid.tsx). "No photographs yet" is a FACT about the library, and
//     a fact is not something a view may assume while it is still asking.
//
//  2. A SHELF IS NEVER SILENTLY SWAPPED FOR ANOTHER ONE. Trash used to bounce
//     to the library when it was empty, which left the member somewhere they
//     did not ask to be with nothing said about why. §14 requires every shelf
//     to be empty ON ITS OWN TERMS, and "Trash is empty." is exactly those
//     terms. The one shelf that legitimately cannot survive a read is an album
//     that no longer exists — there is nothing left to show and no words that
//     would make its absence a state.
//
//  3. OFFLINE IS A STATE THE APP READS, NEVER ONE IT INVENTS. See
//     `libraryReachability` for what this app can and cannot know today.
import type { ShelfId } from "./shelves.ts";
import {
  emptyCopy,
  emptyOffersImport,
  EMPTY_TITLE,
  personEmptyCopy,
  searchMissTitle,
} from "./view-copy.ts";

/**
 * Which shelf survives a read landing.
 *
 * `TRASH` is deliberately absent from this function: an empty trash is a
 * state, not a reason to move the member. The ONLY shelf that cannot survive
 * is an album id the read no longer carries — the album was deleted, so there
 * is no view left to render and no honest sentence about it either.
 */
export function shelfAfterRead(
  shelf: ShelfId,
  albumIds: readonly string[]
): ShelfId {
  if (shelf === null) return null;
  if (typeof shelf !== "string") return shelf;
  if (shelf.startsWith("built-in:") || shelf.startsWith("tag:")) return shelf;
  return albumIds.includes(shelf) ? shelf : null;
}

/** What the current view knows about itself when it has nothing to show. */
export interface EmptyStateInput {
  /**
   * A read has LANDED for this view. False covers both "the first read is
   * still in flight" and "every read so far failed": in neither case does the
   * app know whether the library is empty, so in neither case may it say so.
   */
  loaded: boolean;
  /** How many things this view is showing right now. */
  count: number;
  shelf: ShelfId;
  /** The live search text, trimmed. A miss is about what the member just
   *  typed, not about the shelf. */
  query?: string;
  inAlbum?: boolean;
  /** One confirmed person's own timeline (§5) — their name, not an id. */
  personName?: string | null;
  /** The compact form factor. `Take a photograph` is offered where a camera
   *  is a real way in (§15's Import row: phone only). */
  phone?: boolean;
  /** Something else already answers this view — the new-album input is open,
   *  so the shelf is not standing there with nothing in it. */
  suppressed?: boolean;
}

/** The empty block (§14, proto 4406): one title, one paragraph, two actions. */
export interface EmptyStateView {
  /** Render the block at all. False leaves the region hidden entirely. */
  visible: boolean;
  /** Display serif. The headline the view leads with. */
  title: string;
  /** The reading register — the paragraph, including where the bytes go. */
  body: string;
  /** The filled `Import photographs`. */
  offersImport: boolean;
  /** The outlined `Take a photograph`. */
  offersCamera: boolean;
}

/**
 * Nothing to draw, and — critically — nothing to SAY. Exported because the
 * shelves that answer their own empty view (Search draws §9's four states,
 * Duplicates and Storage draw prose) must take the block DOWN through the same
 * one door every other view puts it up through.
 */
export const NO_EMPTY_STATE: EmptyStateView = {
  visible: false,
  title: "",
  body: "",
  offersImport: false,
  offersCamera: false,
};

/**
 * The empty block for the current view, or `visible: false`.
 *
 * The title/body split is §14's: the display-serif line says what state this
 * is, the reading-register paragraph says what is TRUE about it — and for a
 * library a member could still import into, that includes where the bytes go,
 * which is the load-bearing sentence of the Empty row.
 */
export function emptyStateView(input: EmptyStateInput): EmptyStateView {
  const query = input.query?.trim() ?? "";
  if (!input.loaded || input.suppressed || input.count > 0) {
    return NO_EMPTY_STATE;
  }
  const offersImport = emptyOffersImport(input.shelf, { query });
  return {
    visible: true,
    title: query ? searchMissTitle(query) : EMPTY_TITLE,
    body:
      input.personName && !query
        ? personEmptyCopy(input.personName)
        : emptyCopy(input.shelf, {
            query,
            ...(input.inAlbum ? { inAlbum: true } : {}),
          }),
    offersImport,
    // The camera rides WITH the import offer: a shelf that withholds Import
    // (Trash, a search miss) is not a place a new photograph may land either.
    offersCamera: offersImport && Boolean(input.phone),
  };
}

/**
 * Is the member's library out of reach right now (§14 Offline)?
 *
 * THIS APP CANNOT ASK THE SHELL. The frame contract (`InlineFrame`,
 * apps/inline-types.ts) carries the app bar, the status line and the band —
 * and nothing about reachability. The shell HAS the verdict (its heartbeat
 * monitor drives `StatusLine`'s own offline state), it simply does not pass it
 * down. So this reads the two things the app can honestly observe:
 *
 *  * `hostStatus` — a `data-gateway-status` knob on the app root, the same
 *    dataset channel the host already stamps `data-app-*` knobs onto. When the
 *    shell starts stamping it, this becomes the real signal at zero cost here;
 *    until then it is absent, which reads as "the host did not say".
 *  * `readFailed` — a read that actually came back failed. That is evidence,
 *    not a guess: the inline client tries the local replica and falls back to
 *    the gateway, so a failure means neither answered.
 *
 * `navigator.onLine` is deliberately NOT consulted. On the desktop the gateway
 * is a local child process, so a device with no network reaches it perfectly
 * well — treating that as an outage would put an untrue banner on screen,
 * which is the class of bug this file exists to close.
 */
export function libraryReachability(input: {
  hostStatus?: string | null;
  readFailed: boolean;
}): "reachable" | "unreachable" {
  if (input.hostStatus === "down") return "unreachable";
  if (input.hostStatus === "up") return "reachable";
  return input.readFailed ? "unreachable" : "reachable";
}
