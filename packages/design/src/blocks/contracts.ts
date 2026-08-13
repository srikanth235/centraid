// What the blocks MEAN — the data half of the block vocabulary's props (#765).
//
// The two kits draw the vocabulary twice on purpose: a DOM node and a native
// view are genuinely different things, and the repo's own gates are split along
// that line (`lint-hairline` and `lint-logical-insets` read `StyleSheet`,
// `lint-design-tokens` and `lint-motion-rule` read `.css`). What is NOT
// genuinely different is what a block is BEING TOLD. `net` means the same thing
// on a phone as on a desktop, and when each kit declared that for itself the
// two drifted — measurably:
//
//   * `PanelFact.key` was the DISPLAYED word on the shell and the React list
//     identity on the phone, with a separate `label` carrying the word. One
//     field name, two meanings, on the block a member reads facts from.
//   * A row action carried a stated reason it was unavailable on the shell and
//     could not carry one at all on the phone.
//   * A panel could be toned `seam` on the phone and not on the shell; a fact
//     could be `mono` on the shell and not on the phone; a panel action could be
//     `dangerous` on the shell and not on the phone.
//
// None of that was a decision. It is what happens when the same idea is typed
// twice, so the ideas are typed here once and each kit extends them with only
// its platform half — `onClick`/`className`/`ariaLabel` against
// `onPress`/`style`/`accessibilityLabel`. A kit must NOT redeclare a shared
// field; if it needs a new one, it belongs here, in front of both surfaces.
//
// Types only, deliberately: a contract that shipped runtime code would be a
// third place for behaviour to live. The one import is `import type`, so it is
// erased and the blocks subpath stays free of the icon table at runtime.

import type { IconName } from "../icons";

// ---------------------------------------------------------------------------
// The semantic flags, stated once
// ---------------------------------------------------------------------------
//
// Every flag below appears on more than one block and means exactly this
// wherever it appears. Read these before adding a variant to either kit.
//
//   net        This is about something that LEAVES THE DEVICE, or about a
//              connection to the outside that failed. `--net` is the system's
//              one chromatic ink and it is a border or a metadata tint, never
//              a fill. A `net` row still draws its title in primary ink: a row
//              says "this leaves" with its metadata, not by recolouring the
//              thing it is about.
//   seam       Pending or expiring — a state that is mid-flight rather than
//              wrong. Distinct from `net`, which is about reach.
//   dangerous  The verb destroys or refuses. It takes the OUTLINED destructive
//              recipe; a filled destructive would be a second filled control on
//              a view that is allowed exactly one.
//   off        Present but inert — paused, revoked, not yet enrolled. It
//              recedes on the LEAF (disabled ink, disabled control), never as a
//              container opacity.
//   mono       Render in the numeric register: tabular figures, isolated, ltr.
//              For values that are counts, sizes, times or identifiers.
//   routine    This empty state is one state of a usually-populated view, not a
//              first meeting. The two read differently and must not share copy.

/** A verb attached to something. */
export interface ActionData {
  /** The visible word. Ten rows in a list all say "Open"; see `hint`. */
  label: string;
  /**
   * What distinguishes THIS instance of a repeated verb — "Open the morning
   * digest" beside nine other controls that also read "Open" — or, on an
   * inert control, why it cannot be used.
   *
   * It is a hint and NOT an accessible name because the control already renders
   * visible text, and an `aria-label` would replace what a sighted member reads
   * (aria-label discipline, #708 B.4). The shell lowers it to `title`; the
   * phone lowers it to `accessibilityHint`.
   *
   * BOTH kits must be able to carry it. The phone could not, which is how a
   * screen reader on the phone got ten identical "Open" buttons while the
   * shell's were each named.
   */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One row of the workhorse list — the block every ops page is mostly made of. */
export interface RowData {
  /** Always primary ink, even when the row is `net`. Disabled ink when `off`. */
  title: string;
  /** The explanatory second line. Takes `--net` when the row is `net`. */
  sub?: string;
  /** The row's ONE state word ("Expiring", "Failed", "09:12"). */
  meta?: string;
  net?: boolean;
  dangerous?: boolean;
  off?: boolean;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * One fact in a panel's fact list.
 *
 * `key` is THE DISPLAYED WORD — the uppercase micro rung that sits in the fixed
 * `--w-key-col` column so every value starts at the same edge. It is not a
 * React list identity that happens to be rendered; it is the word, and both
 * kits key their lists on it because fact keys within one panel are unique.
 */
export interface PanelFactData {
  key: string;
  value: string;
  mono?: boolean;
  net?: boolean;
}

/**
 * A panel's edge tone. `neutral` is the hairline; `net` and `seam` colour the
 * EDGE ONLY. There is no filled panel tone in this system.
 */
export type PanelTone = "neutral" | "net" | "seam";

/** The shared shape of a panel's own verb. */
export interface PanelActionData extends ActionData {
  /**
   * This panel carries the view's ONE commit, so its verb is filled. Every
   * other panel verb is outlined. Defaulting this to true anywhere would put a
   * second filled control on the page.
   */
  filled?: boolean;
  dangerous?: boolean;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** One chip of a filter group. */
export interface ChipData {
  /** Stable identity, never rendered. The label is what a member reads. */
  id: string;
  /** One or two words — a chip is a fixed height, so a wrapping label would
   *  break the row rather than the chip. */
  label: string;
  on?: boolean;
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

/**
 * The copy of an empty state. `body` is REQUIRED: a title alone states that
 * there is nothing here without saying whether that is expected, which is the
 * half-answer both kits were free to give while one surface had it optional.
 */
export interface EmptyCopy {
  title: string;
  body: string;
  routine?: boolean;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/** A section head: one label over a hairline, with an optional count beside it. */
export interface SectionCopy {
  /** Never wraps and never shrinks — two lines would read as a second heading. */
  label: string;
  /** The count line ("showing 3 of 12"). Truncates, so the label does not have
   *  to. Numeric, so it renders in the tabular register. */
  meta?: string;
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

/**
 * The data half of the system's oldest shared control.
 *
 * `ButtonVariant` itself already lives in `@centraid/design` and both kits
 * import it — that part never drifted. What drifted is everything around it,
 * and specifically `commit`.
 *
 * TWO FIELDS ARE DELIBERATELY NOT HERE, and both are worth stating so that a
 * later reader does not "fix" the asymmetry:
 *
 *  * `size` (`md` | `sm` | `chrome`) is the shell's. The phone has exactly one
 *    size because the 44px touch floor IS the size, and offering the field
 *    would invite a caller to ask for a 26px titlebar control on a touch
 *    surface.
 *
 *  * `commit` (#708, C7) is the shell's, and this one is NOT an oversight on
 *    the phone. On the shell a commit control disables itself while the gateway
 *    is down, because a shell write goes THROUGH the gateway and would simply
 *    fail. A phone write does not: it lands in the local replica and is
 *    admitted as `queued`, reconciling when the gateway answers again
 *    (docs/mobile-offline.md). Refusing it there would break the offline-first
 *    contract to buy a symmetry nobody asked for. The concept is shared; the
 *    CONSEQUENCE is genuinely per-surface, so the flag stays where it has one.
 */
export interface ButtonData {
  /** Optional because the shell's button also accepts arbitrary children; a
   *  kit with no children escape hatch narrows this to required. */
  label?: string;
  icon?: IconName;
  disabled?: boolean;
}
