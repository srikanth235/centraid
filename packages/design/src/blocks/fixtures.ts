// One canonical example per contract, so a SKIN cannot quietly ignore a flag.
//
// The contracts stop the two kits describing a block differently. They do not
// stop a kit accepting `dangerous` and then drawing the ordinary control — and
// that is not hypothetical: the phone accepted a row verb and had nowhere to
// put its `hint`, and forced filled ink on a panel verb that every error state
// wanted outlined. Both were invisible for as long as each kit's tests only
// asserted against fixtures each kit wrote for itself.
//
// So the FIXTURES live here and the ASSERTIONS live per kit. One object, two
// renderers, two sets of expectations about what the mark looks like — because
// only the kit knows whether "destructive" means a CSS class or a native border
// colour. What neither kit gets to decide is whether the flag was set.
//
// Each fixture deliberately turns on MORE THAN ONE flag at once. A row that is
// only `net` proves nothing about a row that is `net` and `off` together, and
// the interesting bugs live where two flags meet.
//
// Values only. A fixture that computed anything would be a third place for
// behaviour to live, which is the thing this whole module exists to prevent.

import type {
  ButtonData,
  ChipData,
  DistributionDatum,
  EmptyCopy,
  GridColumnData,
  PanelActionData,
  PanelFactData,
  PanelFigureData,
  RowData,
  SectionActionData,
  SectionCopy,
} from "./contracts";

/**
 * A row wearing every tone at once: it is about something leaving the device,
 * its verb destroys, and it is inert. A kit must draw all three — primary ink
 * on the title even so, `net` on the metadata, the destructive outline, and the
 * disabled state on the leaf rather than as a container opacity.
 */
export const ROW_FIXTURE: RowData = {
  title: "Outbound email to tom@pemberton.example",
  sub: "Staged 08:41 · nothing has been sent",
  meta: "Expiring",
  net: true,
  dangerous: true,
  off: true,
};

/** The same row with nothing set — the control case, so a kit's assertions can
 *  show the marks are a RESPONSE to the flags and not always painted. */
export const ROW_PLAIN_FIXTURE: RowData = {
  title: "Tidy downloads",
  sub: "Ran 4 minutes ago",
};

/**
 * A revoked row that stays on the record. It is deliberately NOT also `off`:
 * the two flags are close enough to be confused, and a kit that drew the rule
 * only for the pair would leave every real revoked holder — which is struck and
 * nothing else — reading as if it still held the store.
 */
export const ROW_STRUCK_FIXTURE: RowData = {
  title: "Photos · full store",
  sub: "read · since June",
  meta: "revoked",
  struck: true,
};

/**
 * The verb of an inert row. `hint` is the string a screen reader needs when ten
 * rows all say "Open"; a kit that drops it passes every visual check and leaves
 * a blind member with ten identical controls.
 */
export const ROW_ACTION_FIXTURE = {
  label: "Deny",
  hint: "Deny — outbound email to tom@pemberton.example",
} as const;

/** Two facts: one prose, one numeric-and-consequential. A kit must put the key
 *  in the fixed column, and must tone only the VALUE of the `net` one. */
export const PANEL_FACTS_FIXTURE: readonly PanelFactData[] = [
  { key: "to", value: "tom@pemberton.example" },
  { key: "nothing has been sent", value: "8.4 MB", mono: true, net: true },
];

/** A fact carrying a caveat of its own. A kit that renders the value and drops
 *  the note has silently promised something Conserve does not govern. */
export const PANEL_FACT_NOTE_FIXTURE: PanelFactData = {
  key: "harness runs",
  value: "3 runs · 9.0s active",
  mono: true,
  note: "Measured, not limited by Conserve.",
};

/** The promoted figure: a display-rung value, what it is, and what it leaves
 *  out. A kit that draws the value at the fact rung has promoted nothing. */
export const PANEL_FIGURE_FIXTURE: PanelFigureData = {
  label: "At least · 30 days",
  value: "$3.40",
  qualifier: "$2.10 harness-reported · 1 unpriced.",
};

/** The one filled commit a view is allowed. Everything else stays outlined. */
export const PANEL_COMMIT_FIXTURE: PanelActionData = {
  label: "Approve and send",
  filled: true,
};

/** A panel verb that destroys: outlined in `net`, never filled. */
export const PANEL_DANGEROUS_FIXTURE: PanelActionData = {
  label: "Deny this write",
  dangerous: true,
};

/** An active chip and an inactive one. The active state is stated three ways
 *  and none of them is a hue — colour is spent on `net` and nothing else. */
export const CHIPS_FIXTURE: readonly ChipData[] = [
  { id: "all", label: "Everything", on: true },
  { id: "risk", label: "High risk" },
];

/** The routine empty state — one state of a usually-populated view, which reads
 *  quieter than a first meeting and must not borrow its filled commit. */
export const EMPTY_ROUTINE_FIXTURE: EmptyCopy = {
  title: "Nothing is waiting on you",
  body: "This page is empty most of the time, and that is the healthy state.",
  routine: true,
};

/** The first-run form of the same block: the once-in-a-lifetime screen. */
export const EMPTY_FIRST_RUN_FIXTURE: EmptyCopy = {
  title: "No devices yet",
  body: "Pair this gateway with a phone or a laptop to get started.",
};

/** A section head with a count beside it. The label never wraps; the count
 *  truncates and renders in the tabular register. */
export const SECTION_FIXTURE: SectionCopy = {
  label: "Waiting on you",
  meta: "showing 3 of 12",
};

/**
 * A breakdown whose rows are deliberately OUT of order and unequal: the block
 * must lead with the biggest share, and the third row measured something small
 * enough to round away — so a kit that draws a bare percentage draws nothing
 * where the fixture expects the one-percent floor.
 */
export const DISTRIBUTION_FIXTURE: readonly DistributionDatum[] = [
  { id: "codex", label: "codex", value: "$0.90 · 4k", weight: 0.9 },
  {
    id: "claude-code",
    label: "claude-code",
    value: "$2.50 · 11k",
    weight: 2.5,
  },
  {
    id: "gemini-cli",
    label: "gemini-cli",
    value: "<$0.01 · 40",
    weight: 0.004,
  },
];

/** A section's trailing verb, inert. It must stay QUIET even so — a kit that
 *  reached for the outlined recipe to show the refusal would put a second
 *  bounded control in a head that is meant to read as one line. */
export const SECTION_ACTION_FIXTURE: SectionActionData = {
  hint: "Nothing has been read yet",
  label: "Refresh",
  off: true,
};

/**
 * A grid's columns, carrying every declaration at once: a primary key, a
 * reference with a named target, a sealed column and one the store cannot
 * order by. A kit that draws only the badges it finds convenient passes every
 * visual check and leaves a member unable to tell a reference from a value.
 */
export const GRID_COLUMNS_FIXTURE: readonly GridColumnData[] = [
  { key: "party_id", label: "party_id", pk: true, register: "mono" },
  { key: "display_name", label: "display_name" },
  { fk: "core.place", key: "home_place_id", label: "home_place_id" },
  { key: "secret", label: "secret", sealed: true },
  { fixed: true, key: "extra", label: "extra" },
];

/**
 * One record against those columns, with each cell kind represented: a value,
 * a value long enough to be cut, an absent value, the empty string, and the
 * masking sentinel. `null` and `""` are DIFFERENT cells and a kit must say so.
 */
export const GRID_ROW_FIXTURE: Readonly<Record<string, unknown>> = {
  display_name:
    "Thomasina Pemberton-Marchetti of the Upper Cottage, Little Wenlock",
  extra: "",
  home_place_id: null,
  party_id: "p-1",
  secret: "«sealed»",
};

/** A disabled control carrying an icon — the two Button fields most easily
 *  accepted and then not drawn. */
export const BUTTON_FIXTURE: ButtonData = {
  label: "Re-authorize",
  icon: "Refresh",
  disabled: true,
};
