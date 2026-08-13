// The HEADLESS BLOCK LAYER — the logic the block kits share, with no renderer
// in it (#765).
//
// `packages/client/src/react/ui` (React DOM) and `apps/mobile/src/kit/
// components` (React Native) draw the same block vocabulary twice, because a
// DOM node and a native view are genuinely different things. What is NOT
// genuinely different is the arithmetic and the state rules underneath: how a
// stacked column clamps, how wide the third skeleton bone is, what the snip
// line under a record title says, which of the five operational states may
// carry a verb. Those lived in two trees and drifted; they live here now, and
// each kit keeps only its own rendering.
//
// Reached at `@centraid/design/blocks`, NOT through the package barrel:
// `packages/client` re-exports that barrel and oxlint caps it at 100 modules,
// the same reason `./color`, `./css-vars` and `./oklab` are subpaths.

export { barStack, barWindow } from "./bars";
export type { BarSegments, BarStack } from "./bars";

// The data half of the block props — what each block is TOLD, as opposed to
// how either kit draws it. Types only; see contracts.ts for why.
export type {
  ActionData,
  ButtonData,
  ChipData,
  EmptyCopy,
  PanelActionData,
  PanelFactData,
  PanelTone,
  RowData,
  SectionCopy,
} from "./contracts";

// One canonical example per contract. The fixtures live here; the assertions
// live in each kit, because only a kit knows what its own marks look like.
export {
  BUTTON_FIXTURE,
  CHIPS_FIXTURE,
  EMPTY_FIRST_RUN_FIXTURE,
  EMPTY_ROUTINE_FIXTURE,
  PANEL_COMMIT_FIXTURE,
  PANEL_DANGEROUS_FIXTURE,
  PANEL_FACTS_FIXTURE,
  ROW_ACTION_FIXTURE,
  ROW_FIXTURE,
  ROW_PLAIN_FIXTURE,
  SECTION_FIXTURE,
} from "./fixtures";

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
