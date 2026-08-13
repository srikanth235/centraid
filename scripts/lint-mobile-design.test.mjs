import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeNativeConsumer,
  scanMobileDesign,
} from "./lint-mobile-design.mjs";

test("mobile product grammar has no retired CSS or icon escape hatches", () => {
  assert.deepEqual(scanMobileDesign(), []);
});

test("native consumers must use semantic color, type, and radius roles", () => {
  const findings = analyzeNativeConsumer(`
    const styles = StyleSheet.create({
      title: { color: "#fff", fontFamily: "Arial", fontSize: 16, fontWeight: "700", lineHeight: 20 },
      card: { backgroundColor: "rgba(0,0,0,.4)", borderRadius: 12 },
    });
    const icon = <Icon color="#123456" />;
  `);
  assert.deepEqual(findings, [
    "3: numeric fontSize; use t(<role>)",
    "3: numeric lineHeight; use t(<role>)",
    "3: literal fontWeight; use t(<role>)",
    "3: literal fontFamily; use t(<role>) or family.<code role>",
    "4: numeric radius; use radii.<role>",
    "3: literal style color; use colors.<role>",
    "6: literal JSX color; use colors.<role>",
  ]);
});

test("native semantic lowering is clean", () => {
  assert.deepEqual(
    analyzeNativeConsumer(`
      const styles = StyleSheet.create({
        title: { color: colors.text, ...t("title") },
        card: { backgroundColor: colors.bgElev, borderRadius: radii.lg },
      });
      const icon = <Icon color={colors.accent} />;
    `),
    []
  );
});
