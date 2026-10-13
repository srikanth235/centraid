#!/usr/bin/env node
// Native-controls ratchet gate (DESIGN.md "### The controls (mobile)").
//
// The mobile shells draw every control from the kit — `mobile/iosApp/Sources/Kit`
// and `mobile/androidApp/.../kit` — and a screen reaches for a platform
// primitive only through it. This gate makes the greppable half of that
// section's rulings mechanical. Each rule id names the ruling it enforces:
//
//   native-alert / native-confirmation-dialog (iOS), native-alert-dialog (Android)
//       "Destructive confirms through `ConfirmSheet` (D1) — never an alert,
//       never a confirmation dialog."
//   native-material-button (Android)
//       The control table: an ink button is `InkButton`, an outline button is
//       `QuietButton`, a link is `KitLink`. A Material `Button`, `TextButton`,
//       `OutlinedButton` or `FilledTonalButton` is a hand-rolled second set.
//   native-icon-button (Android)
//       "Icon key": `IconKey` is the 44 target with the 18 glyph; Material's
//       `IconButton` is a different target and a different ink.
//   native-raw-sheet (Android)
//       "Chrome is the platform's; content is the kit's": a sheet's grabber and
//       detents come through the kit's sheet, not a raw `ModalBottomSheet`.
//   native-bare-spinner (both)
//       "Loading, empty and failure go through `ReadStateView`; a bare spinner
//       outside the kit is a finding."
//   native-literal-radius (both)
//       "Radii come from the token scale; a literal radius is a finding."
//       Covers `cornerRadius: 12` and `RoundedRectangle(cornerRadius: 12)` on
//       iOS and `RoundedCornerShape(12.dp)` on Android.
//   native-opacity-disabled (iOS), native-alpha-disabled (Android)
//       "Disabled is the `textDisabled` ink on the leaf, never a faded
//       container." A `.opacity(`/`.alpha(` whose argument tests enabled or
//       disabled state is exactly that fade.
//   native-danger-ink (iOS)
//       "Its ink is `net`, never `danger`."
//
// WHY THE KIT IS EXEMPT. The kit is where these primitives are wrapped: it is
// the one place a `Button`, a `ProgressView()` or a literal radius is allowed,
// because the wrapper is what hands the rest of the app the ruled form. Every
// other file is a screen, and a screen that reaches past the kit forks the
// control table.
//
// BUDGET. Like lint-container-opacity.mjs this is a ratchet, not a
// judgment call at commit time: BUDGET maps `rule -> { file: count }` with
// today's measured counts and only shrinks. A file over its budget, or a file
// with no entry that now counts, fails. A file UNDER its budget also fails —
// the budget must be lowered in the same change, so the debt can never creep
// back into the headroom a fix opened up. Never raise a number: fix the
// screen (reach for the kit control) or open a DESIGN.md argument.
//
// Run with `--print` to emit the measured budget as JSON, the sanctioned way
// to record a decrease. `//` and `/* */` comments are stripped before matching.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const TARGETS = [
  {
    platform: "ios",
    dir: "mobile/iosApp/Sources",
    ext: /\.swift$/u,
    kit: "mobile/iosApp/Sources/Kit",
  },
  {
    platform: "android",
    dir: "mobile/androidApp/src/main/kotlin",
    ext: /\.kt$/u,
    kit: "mobile/androidApp/src/main/kotlin/dev/centraid/android/kit",
  },
];

const SKIP_DIRS = new Set(["build", ".build", "DerivedData", "node_modules"]);

/** Rule table. Each pattern runs per line over comment-stripped source. */
export const RULES = [
  { id: "native-alert", platform: "ios", re: /\.alert\(/gu },
  {
    id: "native-confirmation-dialog",
    platform: "ios",
    re: /\.confirmationDialog\(/gu,
  },
  { id: "native-bare-spinner", platform: "ios", re: /\bProgressView\(\)/gu },
  {
    id: "native-literal-radius",
    platform: "ios",
    re: /\bcornerRadius:\s*\d/gu,
  },
  {
    id: "native-opacity-disabled",
    platform: "ios",
    re: /\.opacity\([^\n]*(?:enabled|disabled)/giu,
  },
  { id: "native-danger-ink", platform: "ios", re: /Theme\.color\("danger"/gu },
  { id: "native-alert-dialog", platform: "android", re: /\bAlertDialog\(/gu },
  {
    id: "native-material-button",
    platform: "android",
    re: /\b(?:TextButton|OutlinedButton|FilledTonalButton)\(|(?<![A-Za-z])Button\(/gu,
  },
  { id: "native-icon-button", platform: "android", re: /\bIconButton\(/gu },
  { id: "native-raw-sheet", platform: "android", re: /\bModalBottomSheet\(/gu },
  {
    id: "native-bare-spinner",
    platform: "android",
    re: /\bCircularProgressIndicator\(/gu,
  },
  {
    id: "native-literal-radius",
    platform: "android",
    re: /\bRoundedCornerShape\(\s*\d+(?:\.\d+)?\.dp\s*\)/gu,
  },
  {
    id: "native-alpha-disabled",
    platform: "android",
    re: /\.alpha\([^\n]*(?:enabled|disabled)/giu,
  },
];

// Shrink-only, and empty: every rule holds at zero outside the kit. A new
// entry here is a debt taken on knowingly, with the reason beside it.
const BUDGET = {};

/** Blank `/* … *\/` and `//` comments, preserving newlines so counts stay
 *  per-line. A `//` preceded by `:` is a URL scheme, not a comment. */
export function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//gu, (m) =>
    m.replace(/[^\n]/gu, " ")
  );
  return noBlock.replace(/(?<!:)\/\/[^\n]*/gu, "");
}

/** Count rule hits in one source file: `{ ruleId: n }` (nonzero only). */
export function scanSource(platform, src) {
  const text = stripComments(src);
  const counts = {};
  for (const rule of RULES) {
    if (rule.platform !== platform) continue;
    const n = (text.match(rule.re) ?? []).length;
    if (n > 0) counts[rule.id] = (counts[rule.id] ?? 0) + n;
  }
  return counts;
}

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(p)) out.push(p);
  }
  return out;
}

/** Measure the tree: `{ rule: { "relative/path": count } }`, kit excluded. */
export function measure(root = ROOT) {
  const measured = {};
  const missing = [];
  for (const target of TARGETS) {
    const dir = path.resolve(root, target.dir);
    if (!existsSync(dir)) {
      missing.push(target.dir);
      continue;
    }
    const kit = path.resolve(root, target.kit) + path.sep;
    for (const file of walk(dir, target.ext)) {
      if (file.startsWith(kit)) continue;
      const rel = path.relative(root, file).split(path.sep).join("/");
      const counts = scanSource(target.platform, readFileSync(file, "utf8"));
      for (const [rule, n] of Object.entries(counts)) {
        (measured[rule] ??= {})[rel] = n;
      }
    }
  }
  return { measured, missing };
}

/** Compare measured counts to the budget. Returns three lists. */
export function compareBudget(measured, budget) {
  const over = [];
  const under = [];
  const rules = new Set([...Object.keys(measured), ...Object.keys(budget)]);
  for (const rule of [...rules].sort()) {
    const have = measured[rule] ?? {};
    const allowed = budget[rule] ?? {};
    const files = new Set([...Object.keys(have), ...Object.keys(allowed)]);
    for (const file of [...files].sort()) {
      const n = have[file] ?? 0;
      const b = allowed[file] ?? 0;
      if (n > b) over.push({ rule, file, count: n, budget: b });
      else if (n < b) under.push({ rule, file, count: n, budget: b });
    }
  }
  return { over, under };
}

/** Per-rule totals of a `rule -> { file: count }` map. */
export function totals(map) {
  return Object.fromEntries(
    Object.entries(map).map(([rule, files]) => [
      rule,
      Object.values(files).reduce((a, b) => a + b, 0),
    ])
  );
}

function sortedBudget(measured) {
  const out = {};
  for (const rule of Object.keys(measured).sort()) {
    out[rule] = Object.fromEntries(
      Object.entries(measured[rule]).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return out;
}

export function lintNativeControls(root = ROOT, budget = BUDGET) {
  const { measured, missing } = measure(root);
  return { missing, measured, ...compareBudget(measured, budget) };
}

function main() {
  if (process.argv.includes("--print")) {
    const { measured, missing } = measure();
    if (missing.length > 0) {
      console.error(`FAIL — target does not exist: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(JSON.stringify(sortedBudget(measured), null, 2));
    return;
  }

  const { missing, measured, over, under } = lintNativeControls();
  if (missing.length > 0) {
    console.error(
      `FAIL — target does not exist: ${missing.join(", ")}. Targets are stale in scripts/lint-native-controls.mjs.`
    );
    process.exit(1);
  }

  if (over.length > 0) {
    console.error(
      "\nFAIL — native controls outside the kit exceed their budget:\n"
    );
    for (const o of over) {
      console.error(
        `  ${o.rule}  ${o.file}: ${o.count} (budget ${o.budget})`
      );
    }
    console.error(
      "\nDESIGN.md \"The controls (mobile)\": draw the control from the kit\n" +
        "(InkButton/QuietButton/KitLink/IconKey/ConfirmSheet/ReadStateView, a\n" +
        "token radius, a leaf disabled ink). Do not raise the budget; see the\n" +
        "header of scripts/lint-native-controls.mjs.\n"
    );
  }
  if (under.length > 0) {
    console.error("\nFAIL — ratchet down: the measured count is below budget:\n");
    for (const u of under) {
      console.error(
        `  ${u.rule}  ${u.file}: ${u.count} (budget ${u.budget}) — lower the BUDGET entry to ${u.count}${u.count === 0 ? " (delete it)" : ""} in scripts/lint-native-controls.mjs`
      );
    }
    console.error(
      "\nThe budget only shrinks, and it shrinks in the same change that fixes the debt.\n"
    );
  }
  if (over.length > 0 || under.length > 0) process.exit(1);

  const t = totals(measured);
  console.log(
    `ok   native controls at budget: ${
      Object.entries(t)
        .sort()
        .map(([r, n]) => `${r}=${n}`)
        .join(" ") || "no debt"
    }`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
