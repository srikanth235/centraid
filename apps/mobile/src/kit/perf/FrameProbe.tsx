// The screen-side half of the #659 frame-drop hook.
//
// `tests/agent-e2e-mobile/flows/scroll-frames.mjs` can drive a fling but cannot
// see a frame timeline: neither Maestro nor adb exposes one for React Native.
// This component is the only way that number leaves the app — it arms on a
// DEV-only testID tap (preferred) or a deep link, counts frames for the window,
// and publishes the result as one copyable line.
//
// It is measurement scaffolding, not a feature, and it behaves like it:
//
// - `__DEV__` only. A production bundle constant-folds `__DEV__` to `false`, so
//   the listener is never installed and the module's body never runs.
// - Nothing polls until a probe asks. No timer, no `requestAnimationFrame` loop
//   between arming and the sample window (D5 — every poller justified).
// - The readout renders only after sampling stops, so drawing it cannot be part
//   of what it measured.

import * as Linking from "expo-linking";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { formatFrameSample, sampleFrames } from "../../lib/perf/frame-sampler";

/**
 * `centraid://perf-frames?ms=4000` still arms one sample for manual use.
 * Maestro prefers `perf-frame-arm` — iOS confirms custom-scheme opens with a
 * system alert and `simctl openurl` often never reaches the Linking listener
 * (30752843689).
 */
const PROBE_PATH = "perf-frames";
const DEFAULT_WINDOW_MS = 4_000;
/** Default window when Maestro taps the DEV arm control (matches scroll-frames). */
const MAESTRO_ARM_WINDOW_MS = 6_000;
const MAX_WINDOW_MS = 30_000;

/**
 * Machine handles for Maestro `id:` selectors, not user-facing copy. The probe
 * hardcodes these strings, so they are part of the contract with
 * `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.
 */
const FRAME_PROBE_ARM_ID = "perf-frame-arm";
const FRAME_PROBE_SAMPLING_ID = "perf-frame-sampling";
const FRAME_PROBE_REPORT_ID = "perf-frame-report";

function windowMsFrom(url: string): number | undefined {
  const parsed = Linking.parse(url);
  // expo-linking may put `perf-frames` in `path` or `hostname` depending on
  // whether the open came as centraid://perf-frames vs centraid:///perf-frames.
  const route = `${parsed.path ?? ""}/${parsed.hostname ?? ""}`;
  if (!route.includes(PROBE_PATH)) return undefined;
  const requested = Number(parsed.queryParams?.ms);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(requested, MAX_WINDOW_MS);
}

export default function FrameProbe(): React.JSX.Element | null {
  const [sampling, setSampling] = useState(false);
  const [report, setReport] = useState<string>();
  const runningRef = useRef(false);

  const arm = (windowMs: number): void => {
    if (runningRef.current) return;
    runningRef.current = true;
    setReport(undefined);
    setSampling(true);
    void sampleFrames(windowMs, {
      requestFrame: (callback) => {
        requestAnimationFrame(callback);
      },
      now: () => performance.now(),
    }).then((sample) => {
      runningRef.current = false;
      setSampling(false);
      setReport(formatFrameSample(sample));
    });
  };

  useEffect(() => {
    if (!__DEV__) return undefined;
    let mounted = true;
    const armFromUrl = (url: string): void => {
      const windowMs = windowMsFrom(url);
      if (windowMs === undefined || !mounted) return;
      arm(windowMs);
    };
    const subscription = Linking.addEventListener("url", ({ url }) =>
      armFromUrl(url)
    );
    void Linking.getInitialURL().then((url) => {
      if (url && mounted) armFromUrl(url);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  if (!__DEV__) return null;
  if (sampling) {
    // Non-zero hit target so XCUITest/Maestro can see the testID (1×1 views
    // were invisible to the hierarchy on iOS 30752843689).
    return (
      <View
        collapsable={false}
        testID={FRAME_PROBE_SAMPLING_ID}
        accessible
        accessibilityLabel={FRAME_PROBE_SAMPLING_ID}
        pointerEvents="none"
        style={styles.marker}
      />
    );
  }
  if (report) {
    return (
      <View pointerEvents="none" style={styles.readout}>
        <Text testID={FRAME_PROBE_REPORT_ID} style={styles.text}>
          {report}
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      collapsable={false}
      testID={FRAME_PROBE_ARM_ID}
      accessible
      accessibilityLabel={FRAME_PROBE_ARM_ID}
      accessibilityRole="button"
      onPress={() => arm(MAESTRO_ARM_WINDOW_MS)}
      style={styles.marker}
    />
  );
}

const styles = StyleSheet.create({
  marker: {
    height: 12,
    opacity: 0.01,
    position: "absolute",
    right: 4,
    top: 4,
    width: 12,
    zIndex: 9999,
  },
  readout: {
    backgroundColor: "#000",
    left: 0,
    padding: 4,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 9999,
  },
  text: { color: "#0f0", fontSize: 10 },
});
