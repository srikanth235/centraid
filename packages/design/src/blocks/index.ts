// HEADLESS BLOCK LAYER (#765): arithmetic/state rules shared by the React DOM
// and React Native block kits. Reached at `@centraid/design/blocks`, NOT the
// package barrel (oxlint caps it at 100 modules).

export { barShares, barStack, barWindow, dayFold, dayMark } from "./bars";
export type {
  BarSegments,
  BarStack,
  DayBucket,
  DayFoldOptions,
  DaySeriesPoint,
} from "./bars";

export { DISTRIBUTION_SHARE_FLOOR, distributionRows } from "./distribution";
export type { DistributionRow } from "./distribution";

export { insightBreakdown, insightSourceRollups } from "./insights";
export type {
  InsightBreakdown,
  InsightMeasuredDatum,
  InsightSourceBucket,
  InsightSourceDatum,
  InsightSourceRollup,
} from "./insights";

// Data half of the block props — types only; see contracts.ts for why.
export type {
  ActionData,
  ButtonData,
  ChipData,
  DistributionDatum,
  EmptyCopy,
  GridColumnData,
  GridRegister,
  GridSortData,
  PanelActionData,
  PanelFactData,
  PanelFigureData,
  PanelTone,
  RowData,
  SectionActionData,
  SectionCopy,
} from "./contracts";

export {
  BUTTON_FIXTURE,
  CHIPS_FIXTURE,
  DISTRIBUTION_FIXTURE,
  EMPTY_FIRST_RUN_FIXTURE,
  EMPTY_ROUTINE_FIXTURE,
  GRID_COLUMNS_FIXTURE,
  GRID_ROW_FIXTURE,
  PANEL_COMMIT_FIXTURE,
  PANEL_DANGEROUS_FIXTURE,
  PANEL_FACT_NOTE_FIXTURE,
  PANEL_FACTS_FIXTURE,
  PANEL_FIGURE_FIXTURE,
  ROW_ACTION_FIXTURE,
  ROW_FIXTURE,
  ROW_PLAIN_FIXTURE,
  ROW_STRUCK_FIXTURE,
  SECTION_ACTION_FIXTURE,
  SECTION_FIXTURE,
} from "./fixtures";

export {
  GRID_CLIP_AT,
  gridCell,
  gridColumnBadges,
  gridColumnHint,
  gridColumnSortable,
  gridSortNext,
  gridSortOf,
} from "./grid";
export type { GridCell, GridCellKind } from "./grid";

export { docRowMenu, docSnipLine } from "./doc-table";
export type {
  DocRowAction,
  DocRowActionLabels,
  DocRowMenu,
  DocRowMenuItem,
} from "./doc-table";

export {
  healthSentence,
  opsGenericLine,
  opsStateCarriesAction,
} from "./ops-state";
export type { OpsGenericLines, OpsState } from "./ops-state";

export {
  boneDelay,
  boneWidths,
  SKELETON_BONE_FLOOR,
  SKELETON_BONE_START,
  SKELETON_BONE_STEP,
  SKELETON_PULSE_HIGH,
  SKELETON_PULSE_LOW,
  SKELETON_PULSE_MS,
  SKELETON_ROWS,
  SKELETON_STAGGER_MS,
} from "./skeleton";
