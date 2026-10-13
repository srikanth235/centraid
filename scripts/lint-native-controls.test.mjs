import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareBudget,
  lintNativeControls,
  scanSource,
  stripComments,
  totals,
} from "./lint-native-controls.mjs";

test("stripComments blanks line and block comments but keeps URLs", () => {
  const out = stripComments(
    `a // .alert(\n/* ProgressView() */ b\nlet u = "https://x.dev"`
  );
  assert.ok(!out.includes(".alert("));
  assert.ok(!out.includes("ProgressView"));
  assert.ok(out.includes("https://x.dev"));
});

test("iOS rules find alerts, dialogs, bare spinners and literal radii", () => {
  const counts = scanSource(
    "ios",
    `
      .alert("x", isPresented: $a) {}
      .confirmationDialog("y", isPresented: $b) {}
      ProgressView()
      ProgressView(value: 0.5)
      RoundedRectangle(cornerRadius: 14)
      .clipShape(RoundedRectangle(cornerRadius: Radius.md))
      .opacity(isEnabled ? 1 : 0.4)
      .opacity(0.5)
      Theme.color("danger", scheme)
      // .alert( in a comment
    `
  );
  assert.deepEqual(counts, {
    "native-alert": 1,
    "native-confirmation-dialog": 1,
    "native-bare-spinner": 1,
    "native-literal-radius": 1,
    "native-opacity-disabled": 1,
    "native-danger-ink": 1,
  });
});

test("Android rules separate Material buttons from kit buttons", () => {
  const counts = scanSource(
    "android",
    `
      AlertDialog(onDismissRequest = {})
      TextButton(onClick = {}) {}
      OutlinedButton(onClick = {}) {}
      FilledTonalButton(onClick = {}) {}
      Button(onClick = {}) {}
      IconButton(onClick = {}) {}
      InkButton(onClick = {})
      QuietButton(onClick = {})
      ModalBottomSheet(onDismissRequest = {})
      CircularProgressIndicator()
      RoundedCornerShape(12.dp)
      RoundedCornerShape(Radius.md)
      Modifier.alpha(if (enabled) 1f else 0.4f)
      Modifier.alpha(0.5f)
    `
  );
  assert.deepEqual(counts, {
    "native-alert-dialog": 1,
    "native-material-button": 4,
    "native-icon-button": 1,
    "native-raw-sheet": 1,
    "native-bare-spinner": 1,
    "native-literal-radius": 1,
    "native-alpha-disabled": 1,
  });
});

test("compareBudget flags growth, new files and unlowered budgets", () => {
  const measured = {
    r: { "a.swift": 3, "b.swift": 1, "new.swift": 1 },
  };
  const budget = { r: { "a.swift": 2, "b.swift": 2, "gone.swift": 1 } };
  const { over, under } = compareBudget(measured, budget);
  assert.deepEqual(
    over.map((o) => o.file),
    ["a.swift", "new.swift"]
  );
  assert.deepEqual(
    under.map((u) => u.file),
    ["b.swift", "gone.swift"]
  );
});

test("totals sums each rule", () => {
  assert.deepEqual(totals({ r: { a: 2, b: 3 }, s: { a: 1 } }), { r: 5, s: 1 });
});

test("lintNativeControls exempts the kit and honours the budget", () => {
  const root = mkdtempSync(path.join(tmpdir(), "native-controls-"));
  try {
    const ios = path.join(root, "mobile/iosApp/Sources");
    const droid = path.join(root, "mobile/androidApp/src/main/kotlin/dev/centraid/android");
    mkdirSync(path.join(ios, "Kit"), { recursive: true });
    mkdirSync(path.join(droid, "kit"), { recursive: true });
    writeFileSync(path.join(ios, "Kit/K.swift"), "ProgressView()\n");
    writeFileSync(path.join(ios, "Screen.swift"), "ProgressView()\n");
    writeFileSync(path.join(droid, "kit/K.kt"), "IconButton(x)\n");
    writeFileSync(path.join(droid, "Screen.kt"), "IconButton(x)\n");

    const rel = "mobile/iosApp/Sources/Screen.swift";
    const relKt = "mobile/androidApp/src/main/kotlin/dev/centraid/android/Screen.kt";
    const ok = lintNativeControls(root, {
      "native-bare-spinner": { [rel]: 1 },
      "native-icon-button": { [relKt]: 1 },
    });
    assert.deepEqual([ok.over, ok.under, ok.missing], [[], [], []]);

    const grew = lintNativeControls(root, {});
    assert.equal(grew.over.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
