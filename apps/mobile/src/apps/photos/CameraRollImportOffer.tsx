import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import { Store } from "../../storage";
import {
  EMPTY_IMPORT_PROGRESS,
  importSummary,
  remainingCandidates,
  runCameraRollImport,
  selectImportCandidates,
} from "./camera-roll-import";
import type { ImportProgress } from "./camera-roll-import";
import { attemptImportCandidate } from "./camera-roll-import-run";
import type { PhotoAsset } from "./timeline-model";

const DISMISSED_KEY = "photos.cameraRollImport.dismissed";
const PROGRESS_KEY = "photos.cameraRollImport.progress";

export interface CameraRollImportOfferProps {
  assets: readonly PhotoAsset[];
  gatewayBase: string | undefined;
}

export default function CameraRollImportOffer({
  assets,
  gatewayBase,
}: CameraRollImportOfferProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);
  const [progress, setProgress] = useState<ImportProgress>();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void Store.hydrate(DISMISSED_KEY, false).then(setDismissed);
    void Store.hydrate(PROGRESS_KEY, EMPTY_IMPORT_PROGRESS).then(setProgress);
  }, []);

  const candidates = selectImportCandidates(assets);
  const remaining =
    progress === undefined
      ? candidates
      : remainingCandidates(candidates, progress);

  if (dismissed === undefined || progress === undefined) return null;
  if (dismissed || remaining.length === 0) return null;

  const start = async (): Promise<void> => {
    if (!gatewayBase || running) return;
    setRunning(true);
    try {
      const result = await runCameraRollImport(candidates, progress, {
        attempt: (candidate) => attemptImportCandidate(gatewayBase, candidate),
        onProgress: (next) => {
          Store.set(PROGRESS_KEY, next);
          setProgress(next);
        },
      });
      setProgress(result);
    } finally {
      setRunning(false);
    }
  };

  const dismiss = (): void => {
    Store.set(DISMISSED_KEY, true);
    setDismissed(true);
  };

  const total = candidates.length;
  const done = total - remaining.length;

  return (
    <View
      accessibilityRole="summary"
      style={[styles.card, { borderColor: colors.line }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>
        {running
          ? `Importing ${done} of ${total}`
          : `Bring ${remaining.length} camera-roll ${
              remaining.length === 1 ? "photograph" : "photographs"
            } into your vault`}
      </Text>
      <Text style={[styles.body, { color: colors.textSoft }]}>
        {running
          ? importSummary(progress)
          : "Staged for review and published one at a time — nothing else on this device is touched."}
      </Text>
      {running ? (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: total, now: done }}
          style={[styles.track, { backgroundColor: colors.line }]}
        >
          <View
            style={[
              styles.fill,
              {
                backgroundColor: colors.text,
                width: `${Math.round((done / Math.max(total, 1)) * 100)}%`,
              },
            ]}
          />
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import"
            accessibilityState={{ disabled: !gatewayBase }}
            disabled={!gatewayBase}
            onPress={() => void start()}
            style={[styles.button, { backgroundColor: colors.accentFill }]}
          >
            <Text style={[styles.buttonText, { color: colors.textInv }]}>
              Import
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Not now"
            onPress={dismiss}
            style={[
              styles.button,
              { borderColor: colors.line, borderWidth: borders.hairline },
            ]}
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>
              Not now
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: spacing[2], marginTop: spacing[3] },
  body: { ...t("small"), marginTop: spacing[1] },
  button: {
    alignItems: "center",
    borderRadius: radii.md,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: spacing[4],
  },
  buttonText: { ...t("control") },
  card: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginHorizontal: spacing[4],
    marginVertical: spacing[2],
    padding: spacing[4],
  },
  fill: { borderRadius: radii.sm, height: 6 },
  title: { ...t("smallStrong") },
  track: {
    borderRadius: radii.sm,
    height: 6,
    marginTop: spacing[3],
    overflow: "hidden",
  },
});
