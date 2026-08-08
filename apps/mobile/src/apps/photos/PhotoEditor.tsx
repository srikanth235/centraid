// THE PHONE'S EDITOR (v4 handoff §7.4, prototype `photoStage()` edit branch).
//
// Crop and rotate, on a phone, non-destructively — the third of the five
// bottom-bar actions that had no surface at all, and the one the handoff calls
// a switcher action: a member who cannot straighten a horizon on the device the
// photograph was taken on has to go and find a desktop.
//
// Three rules shape everything below.
//
//   1. NOTHING IS WRITTEN UNTIL `Save as a new photograph`. Rotating,
//      straightening, snapping to a ratio and dragging the box are arithmetic
//      (`photo-edit-model.ts`) over pixels on the stage. The only call that
//      touches bytes is `onSave`, and the status line says `nothing written
//      yet` for exactly as long as that is true.
//   2. THE EDITOR IS A MODE, NOT A PAGE. It is lightbox-internal state, so the
//      photograph never unmounts, the timeline is never re-entered and there is
//      no route to arrive at with a stale asset. While it is open the viewer's
//      own chrome — filmstrip, prev/next, info, bottom bar — is suppressed
//      (proto 4518, 4599, 4606): a member mid-edit cannot be one swipe away
//      from a different photograph.
//   3. THE COMMIT AND ITS CONSEQUENCE SIT TOGETHER. `Cancel` and `Save as a new
//      photograph` share the SAME wrapping bar as the tools (proto 4617–4630),
//      with the explanation beside them — a member deciding whether to press a
//      button needs the consequence before the press, not in a dialog after it.
//
// The commit is the one filled element here, and a refused commit says why
// inline rather than vanishing.

import { Image } from "expo-image";
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import { buildCropGesture } from "./photo-edit-gestures";
import {
  centredCrop,
  EDITOR_CANCEL,
  EDITOR_RATIOS,
  FULL_CROP,
  clampCrop,
  editorStatus,
  flipLabel,
  isEdited,
  moveCrop,
  nextFlip,
  nextStraighten,
  ratioValue,
  rotatedBox,
  rotatedFrameRatio,
  SAVE_AS_NEW,
  SAVE_AS_NEW_EXPLANATION,
  scaleCrop,
  straightenLabel,
  totalRotation,
} from "./photo-edit-model";
import type { CropRect, EditorRatio, FlipAxis } from "./photo-edit-model";
import { EDITOR_MEDIA_HEIGHT, styles } from "./PhotoEditor.styles";
import type { PhotoAsset } from "./timeline-model";
import { assetAspectRatio, fitMedia } from "./viewer-model";

/** While the bytes are being rendered and enqueued the status line says so —
 *  this surface has no spinner and never will (§18). */
const SAVING = "Rendering the new photograph · the original is not touched";

/** The crop mask's 55% share of the stage, carried on the COLOUR. Derived from
 *  the token rather than pasted as `rgba(11,11,11,.55)`, so the mask follows
 *  the stage if the stage ever moves; the alpha is appended as the 8-digit
 *  hex React Native accepts (0.55 × 255 = 140 = 0x8C). A non-hex stage falls
 *  back to the flat token — a slightly heavy mask beats an invalid colour. */
function maskFill(stage: string): string {
  return /^#[0-9a-f]{6}$/iu.test(stage) ? `${stage}8C` : stage;
}

export interface PhotoEditorProps {
  asset: PhotoAsset;
  /** The stage's width. The media box is 300px tall on a phone (proto 4494). */
  width: number;
  /** Why the commit cannot fire, or undefined when it can. Stated inline. */
  saveDisabledReason?: string;
  /** The live status sentence, lifted so the ONE status line inside the stage
   *  stays where it is rather than the editor growing a second one. */
  onStatus: (line: string) => void;
  onCancel: () => void;
  /** The only path to a write. Resolves when the new photograph is enqueued. */
  onSave: (plan: {
    quarters: number;
    straighten: number;
    crop: CropRect;
    flip?: FlipAxis;
  }) => Promise<void>;
}

export function PhotoEditor({
  asset,
  width,
  saveDisabledReason,
  onStatus,
  onCancel,
  onSave,
}: PhotoEditorProps): React.JSX.Element {
  const { colors } = useTheme();
  const [quarters, setQuarters] = useState(0);
  const [straighten, setStraighten] = useState(0);
  const [ratio, setRatio] = useState<EditorRatio>("Original");
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [flip, setFlip] = useState<FlipAxis>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const rotation = totalRotation(quarters, straighten);
  const sourceRatio = assetAspectRatio(asset);
  const frameRatio = rotatedFrameRatio(sourceRatio, rotation);
  // The box the rotated frame is fitted into. `fitMedia` is the viewer's own
  // fit, so "fit" means the same thing in both modes on the same screen.
  const frame = fitMedia(frameRatio, {
    height: EDITOR_MEDIA_HEIGHT,
    width,
  });
  // The image is drawn at the size whose ROTATED bounding box is exactly the
  // frame, then turned — which is why the preview and the saved pixels agree.
  const unrotated = rotatedBox(sourceRatio, 1, rotation);
  const scale = unrotated.width > 0 ? frame.width / unrotated.width : 0;

  const status = busy
    ? SAVING
    : editorStatus({ flip, quarters, ratio, straighten });
  useEffect(() => {
    onStatus(status);
  }, [onStatus, status]);

  const edited = isEdited({ crop, flip, quarters, ratio, straighten });
  const gesture = buildCropGesture(
    frame,
    (dx, dy) => setCrop((box) => moveCrop(box, dx, dy)),
    (factor) => setCrop((box) => scaleCrop(box, factor))
  );

  function chooseRatio(next: EditorRatio): void {
    setRatio(next);
    const value = ratioValue(next);
    setCrop(value === null ? FULL_CROP : centredCrop(frameRatio, value));
  }

  function rotateQuarter(): void {
    setQuarters((turns) => (turns + 1) % 4);
    // A rectangle drawn against the OLD orientation no longer lines up with
    // anything the member can see, so rotating clears it — the same rule the
    // web editor follows, and the reason a rotation never silently re-crops.
    setCrop(FULL_CROP);
    setRatio("Original");
  }

  function reset(): void {
    setQuarters(0);
    setStraighten(0);
    setRatio("Original");
    setCrop(FULL_CROP);
    setFlip(undefined);
    setFailure(undefined);
  }

  async function save(): Promise<void> {
    if (busy || saveDisabledReason) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onSave({ crop: clampCrop(crop), flip, quarters, straighten });
    } catch (error) {
      setFailure(
        `The new photograph was not saved: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  }

  const tools: {
    key: string;
    label: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }[] = [
    {
      key: "crop",
      label: "Crop",
      // The row's one selected tool (proto 4621: ink border, weight 500). The
      // editor is always cropping — the mark says which tool the box on the
      // stage belongs to, and pressing it returns to a free-form rectangle.
      selected: true,
      onPress: () => chooseRatio("Original"),
    },
    { key: "rotate", label: "Rotate 90°", onPress: rotateQuarter },
    {
      key: "straighten",
      label: straightenLabel(straighten),
      onPress: () => setStraighten(nextStraighten),
    },
    {
      key: "flip",
      label: flipLabel(flip),
      selected: flip !== undefined,
      onPress: () => setFlip(nextFlip),
    },
    ...EDITOR_RATIOS.map((name) => ({
      key: `ratio-${name}`,
      label: name,
      selected: ratio === name && name !== "Original",
      onPress: () => chooseRatio(name),
    })),
    { key: "reset", disabled: !edited, label: "Reset", onPress: reset },
  ];

  const commitBlocked = saveDisabledReason ?? (busy ? SAVING : undefined);

  return (
    <>
      <View style={[styles.stage, { width }]}>
        <GestureDetector gesture={gesture}>
          <View
            accessibilityHint="Drag to move the crop, pinch to resize it"
            accessibilityLabel="Crop area"
            style={[styles.frame, { height: frame.height, width: frame.width }]}
          >
            <Image
              contentFit="fill"
              source={{ uri: asset.previewUri || asset.uri }}
              style={{
                height: scale,
                left: (frame.width - sourceRatio * scale) / 2,
                position: "absolute",
                top: (frame.height - scale) / 2,
                // Flip is a pure mirror of the CONTENT, not the frame — it
                // changes no dimension the crop box's fractions depend on, so
                // it commutes freely with the rotation beside it (same order
                // `renderEdit` applies the two transforms in).
                transform: [
                  { scaleX: flip === "horizontal" ? -1 : 1 },
                  { scaleY: flip === "vertical" ? -1 : 1 },
                  { rotate: `${rotation}deg` },
                ],
                width: sourceRatio * scale,
              }}
            />
            {/* The mask: four panes of the stage's own ground at 55%, which is
                the proto's `rgba(11,11,11,.55)`. The alpha rides the COLOUR,
                never the container: DESIGN.md reserves `opacity` on a box for
                state, so fading the pane would say "inactive" about a scrim
                that is neither. Same reading as the web twin, which draws it
                as the stage token blended with transparency
                (`Editor.module.css`) rather than an opacity. */}
            {[
              { height: `${crop.y * 100}%`, left: 0, right: 0, top: 0 },
              {
                bottom: 0,
                height: `${(1 - crop.y - crop.h) * 100}%`,
                left: 0,
                right: 0,
              },
              {
                height: `${crop.h * 100}%`,
                left: 0,
                top: `${crop.y * 100}%`,
                width: `${crop.x * 100}%`,
              },
              {
                height: `${crop.h * 100}%`,
                right: 0,
                top: `${crop.y * 100}%`,
                width: `${(1 - crop.x - crop.w) * 100}%`,
              },
            ].map((pane, paneIndex) => (
              <View
                key={`mask-${paneIndex}`}
                pointerEvents="none"
                style={[
                  styles.mask,
                  pane as object,
                  { backgroundColor: maskFill(colors.stage) },
                ]}
              />
            ))}
            <View
              pointerEvents="none"
              style={[
                styles.cropBox,
                {
                  borderColor: colors.onStage,
                  height: `${crop.h * 100}%`,
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                },
              ]}
            >
              <View
                pointerEvents="none"
                style={[styles.thirds, { borderColor: colors.stageLine }]}
              />
            </View>
          </View>
        </GestureDetector>
      </View>

      {/* ONE wrapping bar: the tools, the sentence, and the two commits. */}
      <View style={[styles.editBar, { borderTopColor: colors.stageLine }]}>
        <View style={styles.toolRow}>
          {tools.map((tool) => (
            <Pressable
              accessibilityLabel={tool.label}
              accessibilityRole="button"
              accessibilityState={{
                disabled: Boolean(tool.disabled) || busy,
                selected: tool.selected,
              }}
              disabled={Boolean(tool.disabled) || busy}
              key={tool.key}
              onPress={() => tool.onPress()}
              style={[
                styles.tool,
                {
                  borderColor: tool.selected
                    ? colors.onStage
                    : colors.stageLine,
                },
              ]}
            >
              <Text
                style={[
                  styles.toolLabel,
                  {
                    color:
                      tool.disabled || busy
                        ? colors.textDisabled
                        : colors.onStage,
                  },
                ]}
              >
                {tool.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.note, { color: colors.textSoft }]}>
          {SAVE_AS_NEW_EXPLANATION}
        </Text>

        <View style={styles.commitRow}>
          <Pressable
            accessibilityLabel={EDITOR_CANCEL}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onCancel}
            style={[styles.tool, { borderColor: colors.stageLine }]}
          >
            <Text style={[styles.toolLabel, { color: colors.onStage }]}>
              {EDITOR_CANCEL}
            </Text>
          </Pressable>
          <Pressable
            accessibilityHint={commitBlocked}
            accessibilityLabel={SAVE_AS_NEW}
            accessibilityRole="button"
            accessibilityState={{ disabled: Boolean(commitBlocked) }}
            disabled={Boolean(commitBlocked)}
            onPress={() => void save()}
            style={[
              styles.commit,
              // A DISABLED commit is never filled (§18): it drops to the same
              // outline every other control here wears rather than dimming a
              // large filled surface.
              commitBlocked
                ? { borderColor: colors.stageLine }
                : {
                    backgroundColor: colors.onStage,
                    borderColor: colors.onStage,
                  },
            ]}
          >
            <Text
              style={[
                styles.toolLabel,
                { color: commitBlocked ? colors.textDisabled : colors.stage },
              ]}
            >
              {SAVE_AS_NEW}
            </Text>
          </Pressable>
        </View>

        {/* The refusal, inline and in `--net` — never only an accessibility
            hint, and never a hidden control (§6, §18). */}
        {saveDisabledReason || failure ? (
          <Text style={[styles.refusal, { color: colors.net }]}>
            {failure ?? saveDisabledReason}
          </Text>
        ) : null}
      </View>
    </>
  );
}
