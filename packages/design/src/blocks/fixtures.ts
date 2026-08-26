// One canonical example per contract, so a SKIN cannot quietly ignore a flag —
// fixtures here, assertions per kit. Each sets several flags at once: bugs live
// where flags meet. Values only.

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

export const ROW_FIXTURE: RowData = {
  title: "Outbound email to tom@pemberton.example",
  sub: "Staged 08:41 · nothing has been sent",
  meta: "Expiring",
  net: true,
  dangerous: true,
  off: true,
};

export const ROW_PLAIN_FIXTURE: RowData = {
  title: "Tidy downloads",
  sub: "Ran 4 minutes ago",
};

/** Struck without `off` on purpose: a kit drawing the rule only for the pair
 *  misses every real revoked holder. */
export const ROW_STRUCK_FIXTURE: RowData = {
  title: "Photos · full store",
  sub: "read · since June",
  meta: "revoked",
  struck: true,
};

export const ROW_ACTION_FIXTURE = {
  label: "Deny",
  hint: "Deny — outbound email to tom@pemberton.example",
} as const;

export const PANEL_FACTS_FIXTURE: readonly PanelFactData[] = [
  { key: "to", value: "tom@pemberton.example" },
  { key: "nothing has been sent", value: "8.4 MB", mono: true, net: true },
];

export const PANEL_FACT_NOTE_FIXTURE: PanelFactData = {
  key: "harness runs",
  value: "3 runs · 9.0s active",
  mono: true,
  note: "Measured, not limited by Conserve.",
};

export const PANEL_FIGURE_FIXTURE: PanelFigureData = {
  label: "At least · 30 days",
  value: "$3.40",
  qualifier: "$2.10 harness-reported · 1 unpriced.",
};

export const PANEL_COMMIT_FIXTURE: PanelActionData = {
  label: "Approve and send",
  filled: true,
};

export const PANEL_DANGEROUS_FIXTURE: PanelActionData = {
  label: "Deny this write",
  dangerous: true,
};

export const CHIPS_FIXTURE: readonly ChipData[] = [
  { id: "all", label: "Everything", on: true },
  { id: "risk", label: "High risk" },
];

export const EMPTY_ROUTINE_FIXTURE: EmptyCopy = {
  title: "Nothing is waiting on you",
  body: "This page is empty most of the time, and that is the healthy state.",
  routine: true,
};

export const EMPTY_FIRST_RUN_FIXTURE: EmptyCopy = {
  title: "No devices yet",
  body: "Pair this gateway with a phone or a laptop to get started.",
};

export const SECTION_FIXTURE: SectionCopy = {
  label: "Waiting on you",
  meta: "showing 3 of 12",
};

/** Unordered and unequal on purpose: biggest share leads, and the third row
 *  needs the one-percent floor. */
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

export const SECTION_ACTION_FIXTURE: SectionActionData = {
  hint: "Nothing has been read yet",
  label: "Refresh",
  off: true,
};

export const GRID_COLUMNS_FIXTURE: readonly GridColumnData[] = [
  { key: "party_id", label: "party_id", pk: true, register: "mono" },
  { key: "display_name", label: "display_name" },
  { fk: "core.place", key: "home_place_id", label: "home_place_id" },
  { key: "secret", label: "secret", sealed: true },
  { fixed: true, key: "extra", label: "extra" },
];

/** `null` and `""` are DIFFERENT cells and a kit must say so. */
export const GRID_ROW_FIXTURE: Readonly<Record<string, unknown>> = {
  display_name:
    "Thomasina Pemberton-Marchetti of the Upper Cottage, Little Wenlock",
  extra: "",
  home_place_id: null,
  party_id: "p-1",
  secret: "«sealed»",
};

export const BUTTON_FIXTURE: ButtonData = {
  label: "Re-authorize",
  icon: "Refresh",
  disabled: true,
};
