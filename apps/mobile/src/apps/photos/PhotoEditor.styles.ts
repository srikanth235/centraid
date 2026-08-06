// Geometry for the phone's editor. Colour is resolved at the call site from
// the native token layer, exactly as `PhotoLightbox.styles.ts` does it — the
// editor sits on the same stage, so it takes the same three tokens (`stage`,
// `onStage`, `stageLine`) and owns no hex of its own.
//
// The proto's phone form (lines 4494, 4499, 4618): a 52px bar, a 300px media
// height, and an edit bar that WRAPS — the tools and the commit are one bar,
// not two, so a 390px screen reflows them instead of scrolling them.

import { StyleSheet } from "react-native";

import { radii, spacing, t } from "../../kit/theme";

/** Proto 4494: the phone gives the media 300px and the chrome the rest. */
export const EDITOR_MEDIA_HEIGHT = 300;

export const styles = StyleSheet.create({
  /** The stage area the photograph is fitted into while editing. */
  stage: {
    alignItems: "center",
    height: EDITOR_MEDIA_HEIGHT,
    justifyContent: "center",
    overflow: "hidden",
  },
  frame: { position: "relative" },
  /** The four mask panes around the crop box. The proto's single element uses
   *  a 9999px box-shadow spread, which React Native has no equivalent for —
   *  four positioned panes are the same picture with the same token. */
  mask: { position: "absolute" },
  /** The crop box: a 1px on-stage rectangle, nothing filled. */
  cropBox: { borderWidth: 1, position: "absolute" },
  /** The thirds grid: one inset rectangle whose four dashed edges ARE the two
   *  vertical and two horizontal thirds (the proto's `margin:33%` trick). */
  thirds: {
    borderStyle: "dashed",
    borderWidth: 1,
    bottom: "33.33%",
    insetInlineEnd: "33.33%",
    insetInlineStart: "33.33%",
    position: "absolute",
    top: "33.33%",
  },
  /** One wrapping bar carrying the tools, the note and the commit (4618). */
  editBar: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tool: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: "center",
    // Above the 44 floor: these are the editor's primary targets on a phone.
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  toolLabel: { ...t("control") },
  /** 11.5px mono in the proto; the mono role is the native register for it and
   *  carries the 11px floor that a literal font size would not.
   *
   *  `minWidth: 220, flexShrink: 0` (handoff `vEditNoteStyle` :4625 —
   *  `flex:1; min-width:220px`), not `flexBasis` with `flexShrink: 1`: a basis
   *  has no floor once shrinking is allowed, so on a 402pt phone the note
   *  collapsed to ~110pt and wrapped one word per line. The bar already wraps
   *  (`flexWrap: "wrap"`), so a real floor makes the note take its own row
   *  instead of collapsing. */
  note: { ...t("mono"), flexGrow: 1, flexShrink: 0, minWidth: 220 },
  commitRow: { flexDirection: "row", gap: spacing[2] },
  /** `Save as a new photograph` — the ONE filled element in this view (§18).
   *  A disabled commit is never filled, which the call site enforces by
   *  swapping the fill for the outline rather than dimming a filled surface. */
  commit: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  /** Why the commit cannot fire, stated inline in `--net` — never a hint only,
   *  and never a hidden control (§6, §18). */
  refusal: { ...t("mono"), flexBasis: "100%" },
});
