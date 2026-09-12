// THE PROPS EVERY ROOM SHARES (#1015, S1).
//
// Header, back, search, empty, loading, error, status and selection are room
// props, not screen JSX. The audit found six headers, seven back affordances,
// eight-plus empties and five confirm shapes across nine surfaces; none of
// that was a product difference, so none of it is a screen's decision here.
//
// Framework-free on purpose: the band models, the lint rule and the rooms all
// read these shapes, and only the rooms may pull `react-native` in.
//
// SIX ROOMS SHARE THESE, AND THE SEVENTH SHARES NONE (#1015, R-NY-14).
// `StageRoom` takes no header, no back, no search, no `empty`/`loading`/`error`
// and no selection, and that is not an omission to be filled in later: a stage
// is ONE piece of media with nothing to be empty of, nothing to search, and no
// list to select from, and a skeleton the shape of a photograph is a grey
// rectangle pretending to be one. What a stage owes its member instead is a way
// out, which is the one thing it does take (`StageRoom.tsx`). A stage that
// needs a room state needs a different room.

import type { EmptyBlockProps } from "../components/EmptyBlock";

/** One verb: the word, what it does, and whether it is unavailable. */
export interface RoomAction {
  label: string;
  onPress: () => void;
  /** The disabled contract is the leaf's (`Button`); this only declares it. */
  disabled?: boolean;
  /**
   * A handle from `kit/test-ids`, never a hand-spelled string (#890 W2).
   * The verb a room draws is often the one an end-to-end flow taps — Notes'
   * `notes-capture` is the app's whole write door, and Photos' Select chip
   * and its two selection verbs kept their handles across the migration — so
   * a room that swallowed the handle would take those flows away from every
   * screen that moved into it. `lint-mobile-testids` fails the PR that
   * drops one.
   */
  testID?: string;
}

/** Loading is a skeleton at the geometry of what is arriving, never a spinner. */
export interface RoomLoading {
  /** What is being read, in one sentence — the only thing a screen reader
   *  can be told about a surface with no content yet. */
  label: string;
  /** How many bones; the block's own default when omitted. */
  rows?: number;
  /** One line under the bones, for a surface whose content reflows when it
   *  lands. Prose, not a percentage — a skeleton cannot know a fraction. */
  note?: string;
}

/**
 * An error is prose plus ONE retry word. No exception strings, no engine
 * vocabulary: `body` is the app's own noun (S14), and `retry` is one verb.
 */
export interface RoomError {
  title: string;
  body: string;
  retry: RoomAction;
  /** The one way forward when retrying is not it — an unpaired phone's
   *  "Open Settings". Quiet, never a second filled verb. */
  secondary?: RoomAction;
  /** ONE more sentence of the app's own, when the general body cannot say
   *  which of two things went wrong ("This phone is not paired with a gateway
   *  yet."). NEVER an exception string, a status code or engine vocabulary —
   *  that is the whole point of S14. */
  detail?: string;
}

/** The empty state, in whichever of the two registers the screen is in. */
export type RoomEmpty = EmptyBlockProps;

/**
 * A selection is a MODE (#1015, D5): the header swaps in place to
 * "N selected · Cancel", the band dims through leaf tokens and stops
 * answering, and the foot carries ONE action row. Never a second bar under a
 * live band — that was audit B8, where a tap aimed at "Delete" navigated away.
 */
export interface RoomSelection {
  count: number;
  /** Leaves the mode; the word is always "Cancel". */
  onCancel: () => void;
  /** The one action row at the foot; at most one of them is destructive. */
  actions: readonly RoomSelectionAction[];
  /** The SINGULAR noun for the spoken count, pluralised with `s` like
   *  `confirmTitle`'s — `photograph` gives "1 photograph selected" and
   *  "3 photographs selected". */
  noun?: string;
  /**
   * One line above the row saying why some verb in it is unavailable — a
   * read-only vault, say. Never the ONLY place that reason lives: the
   * unavailable control carries it as its own hint too (§6).
   */
  note?: string;
}

export interface RoomSelectionAction extends RoomAction {
  /** Outlined `--net`, never filled — the confirm still asks (S7). */
  dangerous?: boolean;
}

/**
 * What a room tells the band about itself. A room never RENDERS the band —
 * each app owns its own — but it owns the two facts the band may not decide:
 * whether it is live, and whether it is dimmed.
 */
export interface BandState {
  /** Answers taps. False under a selection; the room hides it in an editor. */
  interactive: boolean;
  /** Leaf tokens only — never a container `opacity` (`lint-container-opacity`). */
  dimmed: boolean;
}

/**
 * The band state a room in this selection is in.
 *
 * THE MODE IS THE OBJECT, NOT THE COUNT (#1015, Wave 2). This read `count > 0`
 * first, which left the moment between "Select" and the first pick with a live
 * band, a header that still said the shelf's name, and no way out at all —
 * Docs' drive is where that shows, because its `Select` control stands the
 * primary act down as it turns the mode on. A screen that is not choosing
 * passes no selection; one that is, is choosing at zero as much as at three.
 */
export function bandStateFor(selection?: RoomSelection): BandState {
  const selecting = selection !== undefined;
  return { dimmed: selecting, interactive: !selecting };
}

/**
 * "3 photos selected", or "3 selected" when the caller names no noun. The
 * noun agrees with the count, so one photo is "1 photo selected". At zero the
 * sentence is an instruction rather than a count — "Choose photos" — because
 * "0 photos selected" states a fact nobody needed and asks for nothing.
 */
export function selectedSentence(selection: RoomSelection): string {
  const { count, noun } = selection;
  if (count === 0)
    return noun === undefined ? "Choose what to act on" : `Choose ${noun}s`;
  if (noun === undefined) return `${count} selected`;
  return `${count} ${count === 1 ? noun : `${noun}s`} selected`;
}
