// Screen-side half of the #659 frame-drop hook: arms on a deep link, counts
// frames, publishes one copyable line. Measurement scaffolding, __DEV__-only.

import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { formatFrameSample, sampleFrames } from "../../lib/perf/frame-sampler";
import { Text } from "../components/NativeText";
import { t, useTheme } from "../theme";

/** centraid://perf-frames?ms=N arms one sample. */
const PROBE_PATH = "perf-frames";
const DEFAULT_WINDOW_MS = 4_000;
const MAX_WINDOW_MS = 30_000;
// CI drives a Release app with an embedded bundle, so __DEV__ is false there.
// The explicit build-time flag enables only this measurement surface in the
// disposable E2E artifact; shipping Release builds keep it absent.
const FRAME_PROBE_ENABLED =
  __DEV__ || process.env.EXPO_PUBLIC_CENTRAID_E2E === "1";

/** Hardcoded Maestro testID handles. */
const FRAME_PROBE_SAMPLING_ID = "perf-frame-sampling";
const FRAME_PROBE_REPORT_ID = "perf-frame-report";

function windowMsFrom(url: string): number | undefined {
  const parsed = Linking.parse(url);
  if (!parsed.path?.includes(PROBE_PATH)) return undefined;
  const requested = Number(parsed.queryParams?.ms);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(requested, MAX_WINDOW_MS);
}

export default function FrameProbe(): React.JSX.Element | null {
  const { colors } = useTheme();
  const [sampling, setSampling] = useState(false);
  const [report, setReport] = useState<string>();

  useEffect(() => {
    if (!FRAME_PROBE_ENABLED) return undefined;
    let armed = true;
    let running = false;
    const arm = (url: string): void => {
      const windowMs = windowMsFrom(url);
      if (windowMs === undefined || running) return;
      running = true;
      setReport(undefined);
      setSampling(true);
      void sampleFrames(windowMs, {
        requestFrame: (callback) => {
          requestAnimationFrame(callback);
        },
        now: () => performance.now(),
      }).then((sample) => {
        running = false;
        if (!armed) return;
        setSampling(false);
        setReport(formatFrameSample(sample));
      });
    };
    const subscription = Linking.addEventListener("url", ({ url }) => arm(url));
    // A cold-start probe opens the link before this listener exists.
    void Linking.getInitialURL().then((url) => {
      if (url && armed) arm(url);
    });
    return () => {
      armed = false;
      subscription.remove();
    };
  }, []);

  if (!FRAME_PROBE_ENABLED) return null;
  if (sampling) {
    // Present but nearly nothing: drawn inside the window being measured.
    return (
      <View
        testID={FRAME_PROBE_SAMPLING_ID}
        pointerEvents="none"
        style={styles.armed}
      />
    );
  }
  if (!report) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.readout, { backgroundColor: colors.stage }]}
    >
      <Text
        testID={FRAME_PROBE_REPORT_ID}
        style={[styles.text, { color: colors.success }]}
      >
        {report}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  armed: {
    height: 1,
    position: "absolute",
    right: 0,
    top: 0,
    width: 1,
  },
  readout: {
    left: 0,
    padding: 4,
    position: "absolute",
    right: 0,
    top: 0,
  },
  text: { fontSize: t("mono").fontSize },
});
