// Nothing is written until `Save as a new photograph`. Mode, not a page —
// the photograph stays mounted. Commit and consequence share the tool bar.

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

const SAVING = "Rendering the new photograph · the original is not touched";

/** Alpha on the colour, never `opacity` on the box (DESIGN.md: opacity is state). */
function maskFill(stage: string): string {
  return /^#[0-9a-f]{6}$/iu.test(stage) ? `${stage}8C` : stage;
}

export interface PhotoEditorProps {
  asset: PhotoAsset;
  width: number;
  saveDisabledReason?: string;
  onStatus: (line: string) => void;
  onCancel: () => void;
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
  const frame = fitMedia(frameRatio, {
    height: EDITOR_MEDIA_HEIGHT,
    width,
  });
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
    // Rotation must not silently re-crop against the old orientation.
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
                // Flip mirrors content, not the frame — crop fractions stay valid.
                transform: [
                  { scaleX: flip === "horizontal" ? -1 : 1 },
                  { scaleY: flip === "vertical" ? -1 : 1 },
                  { rotate: `${rotation}deg` },
                ],
                width: sourceRatio * scale,
              }}
            />
            {/* Alpha on colour, never opacity on the pane (DESIGN.md). */}
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

      {/* Tools, sentence, and commits share this bar. */}
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
              // A disabled commit is outlined, never a dimmed fill.
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

        {/* Refusal is visible text, never only an accessibility hint. */}
        {saveDisabledReason || failure ? (
          <Text style={[styles.refusal, { color: colors.net }]}>
            {failure ?? saveDisabledReason}
          </Text>
        ) : null}
      </View>
    </>
  );
}
