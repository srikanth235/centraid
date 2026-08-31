// Screen-side half of the #659 frame-drop hook: arms on a deep link, counts
// frames, publishes one copyable line. Measurement scaffolding.

import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { formatFrameSample, sampleFrames } from "../../lib/perf/frame-sampler";
import { Text } from "../components/NativeText";
import { TEST_IDS } from "../test-ids";
import { t, useTheme } from "../theme";

/** centraid://perf-frames?ms=N arms one sample. */
const PROBE_PATH = "perf-frames";
const DEFAULT_WINDOW_MS = 4_000;
const MAX_WINDOW_MS = 30_000;

/**
 * Is the probe compiled into THIS build?
 *
 * It used to be `__DEV__` alone, and that made the frame budget unmeasurable in
 * principle: every scheduled lane drove a `__DEV__` Hermes build served by
 * Metro, so `scroll-frames` and `cold-start` were reporting numbers from a build
 * no member installs — dropped frames on a development bundle with a live
 * bundler attached are not the product's dropped frames (#890 W1).
 *
 * `EXPO_PUBLIC_CENTRAID_FRAME_PROBE` is inlined by Metro at export time, so the
 * "perf-flavored release" the CI lanes build is a Release-configuration binary,
 * with the Hermes bundle embedded and R8 applied, that additionally carries this
 * one component. A store build never sets the flag, so the probe is absent from
 * it exactly as it was before — the flag WIDENS where the probe can exist, it
 * does not turn it on for members.
 *
 * Read once at module scope: the value is a build-time constant, so re-reading
 * it per render would suggest it can change and it cannot.
 */
const PROBE_COMPILED_IN =
  __DEV__ || process.env.EXPO_PUBLIC_CENTRAID_FRAME_PROBE === "1";

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
    if (!PROBE_COMPILED_IN) return undefined;
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

  if (!PROBE_COMPILED_IN) return null;
  if (sampling) {
    // Present but nearly nothing: drawn inside the window being measured.
    return (
      <View
        testID={TEST_IDS.perf.sampling}
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
        testID={TEST_IDS.perf.report}
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
