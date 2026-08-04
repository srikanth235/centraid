// The screen-side half of the #659 frame-drop hook.
//
// `tests/agent-e2e-mobile/flows/scroll-frames.mjs` can drive a fling but cannot
// see a frame timeline: neither Maestro nor adb exposes one for React Native.
// This component is the only way that number leaves the app — it arms on a deep
// link, counts frames for the window the probe asked for, and publishes the
// result as one copyable line.
//
// It is measurement scaffolding, not a feature, and it behaves like it:
//
// - `__DEV__` only. A production bundle constant-folds `__DEV__` to `false`, so
//   the listener is never installed and the module's body never runs.
// - Nothing polls until a probe asks. No timer, no `requestAnimationFrame` loop,
//   and no re-render happens between arming and the deep link arriving (D5 —
//   every poller justified).
// - The readout renders only after sampling stops, so drawing it cannot be part
//   of what it measured.

import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { formatFrameSample, sampleFrames } from "../../lib/perf/frame-sampler";
import { Text } from "../components/NativeText";

/**
 * `centraid://perf-frames?ms=4000` arms one sample. The probe opens this, does
 * its flings, then reads `perf-frame-report`.
 */
const PROBE_PATH = "perf-frames";
const DEFAULT_WINDOW_MS = 4_000;
const MAX_WINDOW_MS = 30_000;

/**
 * Machine handles for Maestro `id:` selectors, not user-facing copy. The probe
 * hardcodes these strings, so they are part of the contract with
 * `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.
 */
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
  const [sampling, setSampling] = useState(false);
  const [report, setReport] = useState<string>();

  useEffect(() => {
    if (!__DEV__) return undefined;
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
    // A probe may open the link while the app is cold, in which case the event
    // fires before this listener exists.
    void Linking.getInitialURL().then((url) => {
      if (url && armed) arm(url);
    });
    return () => {
      armed = false;
      subscription.remove();
    };
  }, []);

  if (!__DEV__) return null;
  if (sampling) {
    // Present but nearly nothing: the probe needs to know the sample armed, and
    // whatever this draws is drawn inside the window being measured.
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
    <View pointerEvents="none" style={styles.readout}>
      <Text testID={FRAME_PROBE_REPORT_ID} style={styles.text}>
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
    backgroundColor: "#000",
    left: 0,
    padding: 4,
    position: "absolute",
    right: 0,
    top: 0,
  },
  text: { color: "#0f0", fontSize: 13 },
});
