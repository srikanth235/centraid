// The first-run camera-roll import's OFFER (#724) — the honest,
// reviewable alternative to the silent automatic sweep (`photos-backup.ts`).
// A member sees a plain count and two verbs: `Import` runs
// `runImportBatchWithNudge` (`camera-roll-import-run.ts`) through the DURABLE
// UPLOAD QUEUE, nudging this seat once when the batch lands; `Not now`
// dismisses the offer for this device without touching a single photograph.
// Progress is PERSISTED (`Store`) after every candidate settles, so a kill
// mid-import resumes on next launch exactly where it left off — see
// `camera-roll-import.ts`'s header for the resumability argument in full.
//
// PER VAULT, AND PRUNED (#1014, P19). The progress record was one device-wide
// ever-growing array of candidate ids, rewritten in full after every
// photograph and never shortened — so a second vault on the same phone
// inherited the first vault's "already done" list and was offered nothing, and
// a member who deleted photographs kept paying for their ids for ever.
//
// Deliberately a self-contained banner, not a screen of its own or a new
// More-sheet row: `PhotosHome.tsx` renders it in one small, additive slot
// (import + a few lines) rather than growing its own navigation surface,
// so this feature does not compete with concurrent work on that file's band,
// menus or routing.

import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { nudgeSeatCatchUp } from "../../kit/replica/seat-nudge";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import { Store } from "../../storage";
import {
  EMPTY_IMPORT_PROGRESS,
  importSummary,
  pruneProgress,
  remainingCandidates,
  selectImportCandidates,
} from "./camera-roll-import";
import type { ImportProgress } from "./camera-roll-import";
import { runImportBatchWithNudge } from "./camera-roll-import-run";
import type { PhotoAsset } from "./timeline-model";

const DISMISSED_KEY = "photos.cameraRollImport.dismissed";

/** Keyed by vault; an unaddressed seat keeps the historical device-wide key so
 *  an install that never named a vault resumes where it left off. */
function progressKey(vaultId: string | undefined): string {
  return vaultId
    ? `photos.cameraRollImport.progress.${vaultId}`
    : "photos.cameraRollImport.progress";
}

export interface CameraRollImportOfferProps {
  assets: readonly PhotoAsset[];
  gatewayBase: string | undefined;
}

export default function CameraRollImportOffer({
  assets,
  gatewayBase,
}: CameraRollImportOfferProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const replica = useReplica();
  const { session, vaultId } = replica;
  const key = progressKey(vaultId);
  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);
  const [progress, setProgress] = useState<ImportProgress>();
  const [running, setRunning] = useState(false);

  // Hydrated once, exactly the pattern `backupConsent` uses in `PhotosHome.tsx`:
  // the async read resolves into a `.then` callback rather than a synchronous
  // effect-body `setState`, which is what react-compiler's own rule requires.
  useEffect(() => {
    void Store.hydrate(DISMISSED_KEY, false).then(setDismissed);
    void Store.hydrate(key, EMPTY_IMPORT_PROGRESS).then(setProgress);
  }, [key]);

  const candidates = selectImportCandidates(assets);
  const remaining =
    progress === undefined
      ? candidates
      : remainingCandidates(candidates, progress);
  const failedCount =
    progress === undefined ? 0 : Object.keys(progress.failed).length;

  // Nothing to offer: still hydrating, the member said not now, or every
  // camera-roll photograph is already somewhere other than "local-only".
  if (dismissed === undefined || progress === undefined) return null;
  if (dismissed || remaining.length === 0) return null;

  const start = async (): Promise<void> => {
    if (!gatewayBase || !session || running) return;
    setRunning(true);
    try {
      // Forget ids the roll no longer holds before writing the record back
      // (#1014, P19); `done` used to grow for the life of the install.
      const pruned = pruneProgress(progress, candidates, new Set());
      if (pruned !== progress) {
        Store.set(key, pruned);
        setProgress(pruned);
      }
      // The publish commits rows on the GATEWAY, which this phone's own seat
      // knows nothing about; the batch nudges it once at the end so the owner
      // sees their own import within seconds (#1011 M2).
      const result = await runImportBatchWithNudge(
        {
          gatewayBase,
          session,
          ...(vaultId ? { vaultId } : {}),
        },
        candidates,
        pruned,
        {
          nudgeSeat: () => nudgeSeatCatchUp(replica),
          onProgress: (next) => {
            Store.set(key, next);
            setProgress(next);
          },
        }
      );
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
          : failedCount > 0
            ? `${failedCount} camera-roll ${
                failedCount === 1 ? "photograph" : "photographs"
              } did not reach your vault`
            : `Bring ${remaining.length} camera-roll ${
                remaining.length === 1 ? "photograph" : "photographs"
              } into your vault`}
      </Text>
      <Text style={[styles.body, { color: colors.textSoft }]}>
        {running
          ? importSummary(progress)
          : failedCount > 0
            ? // The reason, named, and a verb that acts on it: a failure used
              // to be recorded as done and never offered again (#1014, R8).
              (Object.values(progress.failed)[0] ?? "Something went wrong.")
            : "Queued one at a time and uploaded when your transfer rules allow — nothing else on this device is touched."}
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
            accessibilityLabel={failedCount > 0 ? "Retry" : "Import"}
            accessibilityState={{ disabled: !gatewayBase || !session }}
            disabled={!gatewayBase || !session}
            onPress={() => void start()}
            style={[styles.button, { backgroundColor: colors.accentFill }]}
          >
            <Text style={[styles.buttonText, { color: colors.textInv }]}>
              {failedCount > 0 ? "Retry" : "Import"}
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
