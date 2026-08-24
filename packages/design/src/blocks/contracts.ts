// What the blocks MEAN — the data half of the block vocabulary's props (#765).
//
// The two kits draw the vocabulary twice on purpose: a DOM node and a native
// view are genuinely different things, and the repo's own gates are split along
// that line (`lint-hairline` and `lint-logical-insets` read `StyleSheet`,
// `lint-design-tokens` and `lint-motion-rule` read `.css`). What is NOT
// genuinely different is what a block is BEING TOLD. `net` means the same thing
// on a phone as on a desktop, and two independent declarations of a shared
// meaning drift — #765 catalogues the measured drift that forced this module.
// So the ideas are typed here once and each kit extends them with only
// its platform half — `onClick`/`className`/`ariaLabel` against
// `onPress`/`style`/`accessibilityLabel`. A kit must NOT redeclare a shared
// field; if it needs a new one, it belongs here, in front of both surfaces.
//
// Types only, deliberately: a contract that shipped runtime code would be a
// third place for behaviour to live. The one import is `import type`, so it is
// erased and the blocks subpath stays free of the icon table at runtime.

import type { IconName } from "../icons";

// ─── The semantic flags, stated once ───────────────────────────────────────
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
//   struck     This was REVOKED, and the record of it stays. The title is
//              ruled through in disabled ink and the row keeps its height, its
//              hairlines and its place in the list: a revoked holder that
//              vanished would leave a member unable to see that it was ever
//              there. Distinct from `off`, which is inert but still standing.
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

// ─── Rows ───────────────────────────────────────────────────────────────

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
  /** Revoked, and still on the record — ruled through, never removed. */
  struck?: boolean;
}

// ─── Panel ──────────────────────────────────────────────────────────────

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
  /**
   * A caveat that belongs to THIS fact and to no other — "measured, not
   * limited by Conserve" under the harness-runs figure.
   *
   * It is a line under the value rather than a footnote at the foot of the
   * panel, because a footnote is a caveat the reader has to match back up to
   * the number it qualifies, and the reader who most needs it is the one
   * skimming. A panel-wide caveat is `body`; this one is not panel-wide.
   */
  note?: string;
}

/**
 * The one fact promoted out of the list — display type, with a qualifier line
 * under it.
 *
 * A page whose whole question is "did this month cost $2 or $200" answers it in
 * the type scale or it does not answer it: the same figure at the fact rung is
 * a 13px string among thirty other 13px strings, and the reader has to read to
 * find out. AT MOST ONE per view, for the same reason a view gets one filled
 * commit — two promoted figures promote nothing.
 */
export interface PanelFigureData {
  /**
   * The figure, ALREADY WORDED ("$3.40", "1,284"). A block never formats a
   * number: what "$3.40" means (a floor? a total?) is the screen's knowledge.
   */
  value: string;
  /** What the figure is — "Spend · 30 days". The eyebrow rung above it. */
  label: string;
  /** The honesty line under it: how the figure was arrived at, or what it
   *  leaves out. Absent when the figure needs no qualifying. */
  qualifier?: string;
  /** The figure is bad news (spend over budget, a failure count). Colours the
   *  VALUE, on the same terms as a `net` fact. */
  net?: boolean;
}

// ─── Distribution ───────────────────────────────────────────────────────

/**
 * One labelled proportional row: a word, an already-worded figure, and the
 * magnitude its share bar is measured from.
 *
 * `weight` is deliberately NOT derived from `value`: a share is arithmetic over
 * one unit (dollars) while the figure beside it is copy that usually carries
 * two ("$2.50 · 11k"). Parsing the copy back into a number would make the bar
 * depend on how the row happened to be worded.
 */
export interface DistributionDatum {
  /** Stable identity, never rendered — two windows can label a row the same. */
  id: string;
  /** The word ("claude-code", "high"). One line: it truncates, never wraps,
   *  because a wrapping label would step the row off the share bar's baseline. */
  label: string;
  /** The measured figure, already worded. Numeric register. */
  value: string;
  /** The magnitude the share is measured from. Non-positive counts as zero. */
  weight: number;
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

// ───────────────────────────────────────────────────────────────────────────
// Chips
// ───────────────────────────────────────────────────────────────────────────

/** One chip of a filter group. */
export interface ChipData {
  /** Stable identity, never rendered. The label is what a member reads. */
  id: string;
  /** One or two words — a chip is a fixed height, so a wrapping label would
   *  break the row rather than the chip. */
  label: string;
  on?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Empty
// ───────────────────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────────────────
// Section
// ───────────────────────────────────────────────────────────────────────────

/** A section head: one label over a hairline, with an optional count beside it. */
export interface SectionCopy {
  /** Never wraps and never shrinks — two lines would read as a second heading. */
  label: string;
  /** The count line ("showing 3 of 12"). Truncates, so the label does not have
   *  to. Numeric, so it renders in the tabular register. */
  meta?: string;
}

/**
 * A section's TRAILING VERB — "Refresh", "Rows/Bytes", "Sort".
 *
 * A section head is the only place a per-section verb can honestly live. The
 * app bar carries the ROUTE's verbs, so a verb about one section of a route
 * has to either move up there and lose its subject ("Refresh" — refresh what?)
 * or become a control floating beside the rows with no head to belong to.
 * Neither is the vocabulary; this slot is.
 *
 * It is ALWAYS quiet — no fill, no outline. Invariant 3 allows one filled
 * control per view and it is the view's commit; a section verb is never that.
 * A verb that DESTROYS is not admitted here either: a destructive control
 * belongs on the thing it destroys, in the row or the panel that names it.
 *
 * Many of these verbs state the CURRENT setting rather than an imperative
 * ("Newest first", "Rows/Bytes") — a toggle whose label is its own readout, so
 * the section head does not need a second element to say where it stands.
 */
export interface SectionActionData extends ActionData {
  /** Present but inert — the verb is stated and refused, so a member can see
   *  that the capability exists while the section has nothing to apply it to. */
  off?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Grid
// ───────────────────────────────────────────────────────────────────────────

/**
 * The register a column's values are drawn in.
 *
 * PER COLUMN, not per grid: a records table is mostly identifiers, counts and
 * timestamps with one or two prose fields among them, and a grid that picked
 * one register for the whole table would either set prose in tabular figures
 * or let ids reflow under RTL. `mono` is the numeric register — tabular
 * figures, isolated, ltr — and `text` is ordinary ink.
 */
export type GridRegister = "text" | "mono";

/**
 * One declared column of a grid.
 *
 * The declaration is separate from the values on purpose: a grid is told what
 * its columns MEAN once, and then handed rows that are plain records. That is
 * what lets the header carry the key badges and the foreign-key target without
 * every cell repeating them.
 */
export interface GridColumnData {
  /** The record field this column reads, and the key a sort is expressed in. */
  key: string;
  /** The displayed header word. */
  label: string;
  register?: GridRegister;
  /** Part of the record's primary key. Drawn as a badge on the header. */
  pk?: boolean;
  /**
   * The logical name of the table this column points at, when it is a foreign
   * key. Presence is the `fk` badge; the value is the target a member needs to
   * know a column is a reference and to WHAT.
   */
  fk?: string;
  /**
   * The store never returns this column in plaintext. Its cells draw the
   * sealed mark instead of a value — including when the caller was handed the
   * masking sentinel, which must never reach a screen as text.
   */
  sealed?: boolean;
  /** The store cannot order by this column. The header is a label, not a
   *  control: a sort affordance that answers "no" is worse than none. */
  fixed?: boolean;
}

/** Which column a grid is ordered by, and which way. */
export interface GridSortData {
  key: string;
  dir: "asc" | "desc";
}

// ───────────────────────────────────────────────────────────────────────────
// Button
// ───────────────────────────────────────────────────────────────────────────

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
