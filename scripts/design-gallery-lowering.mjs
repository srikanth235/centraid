// The BI and MO capture lanes of `design-gallery.mjs`.
//
// These two surfaces have NO DOM the product renders: `toBlueprintCss()` and
// `toNativeTheme()` are LOWERINGS, and an inline blueprint app needs a gateway
// and a vault to paint while a React Native surface has no document at all.
// So each lane photographs the lowering itself — a sheet of its own RESOLVED
// custom properties, every colour as a swatch, every value spelled out in
// full. That fences "this lowering reaches this surface with the values the
// registry declares", which is the whole of the claim, and it depicts nothing
// the platform does not emit.
//
// This is not the fixture #799 deleted. The fixture invented a component
// vocabulary — `.kit-panel`, `.kit-btn`, `.row`, `.notice` — and photographed
// it as if it were the product. Nothing here renders a component.
import { toFontFaceCss } from "../packages/design/src/font-faces.ts";
import {
  fonts,
  toBlueprintCss,
  toNativeTheme,
} from "../packages/design/src/index.ts";

/** Where the served dist answers for the vendored faces — the same literal
 *  path `apps/web/vite.config.ts` bakes into the shell's token CSS. */
const FONT_BASE = "/fonts";
const SANS = fonts.sans;

function nativeTokenCss(scheme) {
  const theme = toNativeTheme(scheme);
  const vars = [];
  const kebab = (key) =>
    key.replace(
      /(?<letter>[A-Z])/gu,
      (_match, letter) => `-${letter.toLowerCase()}`
    );
  for (const [key, value] of Object.entries(theme.colors))
    vars.push(`--${kebab(key)}: ${value};`);
  for (const [key, value] of Object.entries(theme.radii))
    vars.push(`--r-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(theme.spacing))
    vars.push(`--sp-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(theme.type))
    vars.push(
      // The family is the product's, not `system-ui`: mobile renders
      // `InstrumentSans_400Regular`/`_600SemiBold`, which are the same faces
      // this sheet loads as `.woff2` (#799 — the `system-ui` literal here was
      // the fidelity bug that made these baselines OS-dependent).
      `--t-${kebab(key)}: ${value.weight} ${value.fontSize}px/${value.lineHeight}px '${SANS}';`
    );
  vars.push(
    `--target-min: ${theme.targetMin.coarse}px;`,
    `--dur-1: ${theme.durations.one}ms;`,
    `--dur-2: ${theme.durations.two}ms;`,
    "--ease: cubic-bezier(0.2, 0.7, 0.3, 1);",
    `--font-sans: '${SANS}', sans-serif;`,
    "--font-code: ui-monospace, monospace;"
  );
  return `:root { ${vars.join(" ")} }`;
}

/** Every custom property the lowering declares, in declaration order. */
function tokenNames(css) {
  const names = [];
  const seen = new Set();
  for (const match of css.matchAll(/(?<name>--[\w-]+)\s*:/gu)) {
    const { name } = match.groups;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * A page that carries the lowering and nothing else. The rows are filled in
 * from the RESOLVED computed values once the page is live (a `var()` chain
 * cannot be resolved in Node), so what the baseline shows is what the surface
 * actually gets, not what the emitter's source text says.
 */
function loweringSheetHtml({ surface, scheme, css }) {
  return `<!doctype html>
<html data-theme="${scheme}">
<head><meta charset="utf-8"><style>
${toFontFaceCss(FONT_BASE)}
${css}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--t-body); font-family: '${SANS}', sans-serif; }
.sheet { padding: 24px; display: grid; align-content: start; gap: 4px; }
.sheet h1 { margin: 0 0 12px; font: var(--t-title); font-family: '${SANS}', sans-serif; }
/* No truncation anywhere: the VALUE is the thing this lane fences, so an
   ellipsis would photograph the claim away. */
.tok { display: grid; grid-template-columns: 11rem 1fr 2.25rem; align-items: start; gap: 10px; padding: 2px 0; border-top: 1px solid var(--line); }
.tok-name, .tok-value { font: var(--t-mono); font-family: '${SANS}', sans-serif; color: var(--text-soft); overflow-wrap: anywhere; }
.tok-swatch { height: 15px; border: 1px solid var(--line); }
</style></head>
<body><main class="sheet" data-lowering-surface="${surface}" data-lowering-scheme="${scheme}">
<h1>${surface} token lowering · ${scheme}</h1>
</main></body></html>`;
}

/** Fill the sheet from the resolved custom properties. */
async function paintLoweringSheet(page, names) {
  return page.evaluate((tokens) => {
    const sheet = document.querySelector(".sheet");
    const style = getComputedStyle(document.documentElement);
    const painted = [];
    for (const name of tokens) {
      const value = style.getPropertyValue(name).trim();
      if (!value) continue;
      painted.push(name);
      const row = document.createElement("div");
      row.className = "tok";
      const label = document.createElement("span");
      label.className = "tok-name";
      label.textContent = name;
      const shown = document.createElement("span");
      shown.className = "tok-value";
      shown.textContent = value;
      const swatch = document.createElement("span");
      swatch.className = "tok-swatch";
      swatch.style.background = `var(${name})`;
      row.append(label, shown, swatch);
      sheet.appendChild(row);
    }
    return painted;
  }, names);
}

/**
 * Capture one lowering lane. `assert*` are passed in rather than imported:
 * they belong to the gate's contract half, and this module owns only the
 * rendering half.
 */
export async function captureLowering(page, origin, entry, assertions) {
  const css =
    entry.surface === "BI" ? toBlueprintCss() : nativeTokenCss(entry.scheme);
  // Navigated first, not `setContent` alone: the sheet must be same-origin
  // with the served dist so `/fonts/*.woff2` resolves to the vendored bytes.
  await page.goto(`${origin}/`, { waitUntil: "commit" });
  await page.setContent(
    loweringSheetHtml({ css, scheme: entry.scheme, surface: entry.surface }),
    { waitUntil: "load" }
  );
  const painted = await paintLoweringSheet(page, tokenNames(css));
  if (painted.length === 0)
    throw new Error(`${entry.id}: the lowering resolved no custom properties`);
  await assertions.productFaceResolved(page, entry.id);
  await assertions.renderable(page, "main[data-lowering-surface]", entry.id);
  await assertions.legalTypeTriples(
    page,
    "main[data-lowering-surface]",
    entry.id
  );
  await page.addStyleTag({ content: assertions.freezeMotion });
}
