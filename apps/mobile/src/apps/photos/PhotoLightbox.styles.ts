// Geometry for the viewer. Colour lives at the call site, resolved from the
// native token layer — the stage is `colors.stage`, its ink `colors.onStage`,
// its hairlines `colors.stageLine`. There is no hex in this file on purpose:
// a literal here would be a second source of truth for a value the design
// system already owns, and RN resolves the tokens at build time anyway.
//
// Type comes from `t(...)`, never a bare `fontSize` — that is what keeps the
// 11px floor and the tabular numeric register honest at 200% text scale.

import { StyleSheet } from "react-native";

import { radii, spacing, t } from "../../kit/theme";
import {
  FILMSTRIP,
  VIEWER_ACTION_TARGET,
  VIEWER_CHROME_CHIP,
  VIEWER_CHROME_INSET,
} from "./viewer-model";

export const styles = StyleSheet.create({
  /** The bottom row: chip · capsule · chip, with NOTHING behind them. The row
   *  itself is transparent — `space-between` is what pushes the two single
   *  actions to the thumbs and leaves the capsule centred, which is the whole
   *  arrangement (`VIEWER_BOTTOM_GROUPS`). A background here would put the
   *  full-width bar straight back. */
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: VIEWER_CHROME_INSET,
    paddingVertical: VIEWER_CHROME_INSET,
  },
  /** The read-only reason under the viewer's bottom bar (§6, §18): stated
   *  inline, in `--net` mono, never carried only in an accessibility hint —
   *  colour is applied at the call site, same pattern as `statusText`. */
  viewerReadOnlyReason: {
    ...t("mono"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[3],
  },
  /** Facts, under the hairline. Mono, so it reads in order under RTL. The
   *  VALUE column takes the row's remaining width (handoff `vFacts`
   *  key/value css, ~:4590-4595 — `flex:1`), so a long value (the asset-id
   *  UUID) wraps inside its own column instead of running edge to edge. */
  facts: { ...t("mono"), flex: 1, marginTop: spacing[1] },
  /** The facts row's KEY column — fixed at 96px, `flex: none` (handoff
   *  `vFacts`, ~:4590-4595), unlike the shared `infoLabel` (`flex: 1`) that
   *  the column-stacked rows above (Caption, Place, Tags, People, Vault) use.
   *  Those rows put the label on its own line above a full-width value, so
   *  `infoLabel`'s `flex: 1` never mattered there; here label and value share
   *  one row, and without a fixed key column the value's width fights the
   *  label's for the row's leading half — which is what pushed a long value
   *  to the trailing screen edge and crowded its label. */
  factLabel: { ...t("small"), flexGrow: 0, flexShrink: 0, width: 96 },
  factsRow: { flexDirection: "row", gap: spacing[3], paddingVertical: 3 },
  fill: { flex: 1 },
  filmstrip: {
    height: FILMSTRIP.height,
  },
  /** Layout of the frames INSIDE the scrollable strip. React Native refuses
   *  `alignItems` (and every other child-layout prop) on a ScrollView's own
   *  `style` with an invariant violation — a horizontal list centres and pads
   *  its content through `contentContainerStyle`, never through the box. */
  filmstripContent: {
    alignItems: "center",
    paddingHorizontal: spacing[3],
  },
  filmstripCurrent: {
    borderWidth: FILMSTRIP.currentOutlineWidth,
    height: FILMSTRIP.current,
    width: FILMSTRIP.current,
  },
  filmstripFrame: { marginEnd: FILMSTRIP.gap },
  filmstripNeighbour: {
    height: FILMSTRIP.neighbour,
    width: FILMSTRIP.neighbour,
  },
  grabberSlot: { paddingBottom: spacing[1] },
  infoLabel: { ...t("small"), flex: 1 },
  infoMeaning: { ...t("small"), marginTop: 2 },
  infoRow: { paddingVertical: spacing[2] },
  infoValue: { ...t("small") },
  /** The refusal panel: outlined `--net`, never a filled red surface. */
  refusal: {
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 2,
    marginTop: spacing[2],
    padding: spacing[2],
  },
  refusalText: { ...t("small") },
  refusalTitle: { ...t("control") },
  hairline: {
    borderTopWidth: 1,
    marginTop: spacing[3],
    paddingTop: spacing[2],
  },
  liveText: { ...t("eyebrow") },
  mediaCenter: { alignItems: "center", justifyContent: "center" },
  modalBackdrop: { flex: 1 },
  /** Prev / next: 44 circles inset 12, mirrored under RTL by the logical
   *  inset pair (never the legacy `start`/`end`, which type but do not lay
   *  out — see scripts/lint-logical-insets.mjs). */
  pager: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    position: "absolute",
    top: "50%",
    width: 44,
  },
  pagerNext: { insetInlineEnd: spacing[3] },
  pagerPrev: { insetInlineStart: spacing[3] },
  chip: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: 6,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing[1] },
  chipText: { ...t("control") },
  captionInput: { ...t("small"), borderBottomWidth: 1, paddingVertical: 6 },
  sheet: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    bottom: 0,
    paddingHorizontal: spacing[4],
    position: "absolute",
    width: "100%",
  },
  sheetBody: { paddingBottom: spacing[5] },
  sheetTitle: { ...t("title"), marginBottom: spacing[1] },
  /** The status line inside the stage. One line, clamped, never clipped. */
  statusLine: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: spacing[2],
    minHeight: 30,
    paddingHorizontal: spacing[3],
    paddingVertical: 6,
  },
  statusAction: { ...t("control") },
  statusText: { ...t("mono"), flex: 1 },
  /** The transport: play, a determinate track, a clock, a kind label. */
  track: { borderRadius: radii.pill, flex: 1, height: 3 },
  trackFill: { borderRadius: radii.pill, height: 3 },
  /** The scrub-preview strip (issue #724 B2b) — a row of real poster frames
   *  above the Live Photo transport's track, letting a member see the motion
   *  before pressing play. Absent (not a placeholder box) wherever
   *  `expo-video-thumbnails` cannot honestly produce one — see
   *  `video-scrub-strip-native.ts`. */
  scrubStrip: { flexDirection: "row", gap: 2, paddingHorizontal: spacing[3] },
  scrubStripFrame: { borderRadius: radii.sm, height: 34, width: 34 },
  transport: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  transportClock: { ...t("mono") },
  /** The three floating elements at the head of the stage. Absolute, so the
   *  photograph runs underneath rather than being pushed down by a bar; the
   *  logical inset pair (never the legacy `start`/`end`, which type but do not
   *  lay out — see scripts/lint-logical-insets.mjs) is what mirrors it. The
   *  safe-area top is added at the call site, because only the component knows
   *  the insets. */
  chromeTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2],
    insetInlineEnd: 0,
    insetInlineStart: 0,
    justifyContent: "space-between",
    paddingBottom: VIEWER_CHROME_INSET,
    paddingHorizontal: VIEWER_CHROME_INSET,
    position: "absolute",
    top: 0,
    zIndex: 2,
  },
  /** The plate a chip or a capsule IS. `radii.pill` rounds a 44-square plate
   *  to a circle and a wider one to a capsule, so there is one style, not two
   *  that can drift apart. Ground and edge come from the stage ramp at the
   *  call site (`--stage-sunken` / `--stage-line`), opaque, never glass. */
  chromePlate: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: "row",
    // The stamp's line can be long — the editor's live sentence, a place name —
    // and the row it sits in has two chips it must not push off the screen.
    // `minWidth: 0` is what lets the clamp inside actually take effect; without
    // it a flex child refuses to shrink below its content and the row overflows.
    flexShrink: 1,
    minHeight: VIEWER_CHROME_CHIP,
    minWidth: 0,
    overflow: "hidden",
  },
  /** Holds the trailing slot open while the editor suppresses its control, so
   *  the stamp does not slide off centre when the mode changes. */
  chromeSpacer: { height: VIEWER_CHROME_CHIP, width: VIEWER_CHROME_CHIP },
  chromeStamp: {
    alignItems: "center",
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  /** The capture date carries the stamp's weight; `smallStrong` is the scale's
   *  emphatic body rung, and the token layer decides what it means at 200%. */
  chromeStampDate: { ...t("smallStrong") },
  /** `17:42 · Lyme Regis` — mono and tabular, because a clock is a number. */
  chromeStampTime: { ...t("mono") },
  chromeTarget: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: VIEWER_CHROME_CHIP,
    minWidth: VIEWER_CHROME_CHIP,
  },
  /** Inside a capsule: neighbours at 44 is where mis-taps start (§7.1). */
  chromeTargetWide: { minWidth: VIEWER_ACTION_TARGET },
  /** A worded target in a plate — the slideshow's `Leave`, which is the one
   *  control here that is a verb rather than a mark. */
  chromeTextTarget: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: VIEWER_CHROME_CHIP,
    paddingHorizontal: spacing[3],
  },
  /** The video's kind label — `video · 4K · 0:24` — where the hand-rolled
   *  transport used to be. Centred under the frame, micro-caps, and the only
   *  thing we say about a recording the platform's own controls are playing. */
  kindLabel: {
    ...t("eyebrow"),
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    textAlign: "center",
  },
  /** The zoom ladder, CENTRED over the media (proto 4534) rather than pinned
   *  to a corner: it is about the photograph, so it sits on it. `alignSelf`
   *  rather than `start`/`end` is what centres an absolutely positioned child
   *  under Yoga, and it mirrors correctly under RTL for free. */
  zoomPill: {
    alignItems: "center",
    alignSelf: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    bottom: spacing[3],
    flexDirection: "row",
    gap: 2,
    paddingHorizontal: spacing[1],
    position: "absolute",
  },
  /** Each rung is its own 44 target — the prototype's 26px pills are a
   *  pointer geometry, and this bar is pressed with a thumb. */
  zoomStep: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing[1],
  },
  zoomStepLabel: { ...t("control") },
  /** `240% · drag to pan`. Mono and tabular so the number does not jitter as
   *  it climbs; colour is `--on-stage-soft` at the call site. */
  zoomReadout: { ...t("mono"), paddingEnd: spacing[2] },
});
