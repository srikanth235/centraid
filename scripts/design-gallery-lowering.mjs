import { toFontFaceCss } from "../packages/design/src/font-faces.ts";
import {
  fonts,
  toBlueprintCss,
  toNativeTheme,
} from "../packages/design/src/index.ts";

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

export async function captureLowering(page, origin, entry, assertions) {
  const css =
    entry.surface === "BI" ? toBlueprintCss() : nativeTokenCss(entry.scheme);
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
