// Build the Centraid blueprint-kit design-system input for design-sync
// (issue #327). NO compile step, NO React wrappers.
//
// The kit's components are now native Web Components (`packages/blueprints/kit/
// elements.js`, defined with `customElements.define()`), which claude.ai/design
// ingests directly — so this build no longer authors or `tsc`-compiles a React
// wrapper package. It just:
//   1. regenerates the token CSS from the built `@centraid/design-tokens`,
//   2. copies the canonical `kit.css` verbatim,
//   3. concatenates tokens + fonts + bridge + kit.css into `styles/bundle.css`
//      (the `cssEntry` every rendered design receives),
//   4. copies the REAL component source (`elements.js`, dependency-free —
//      no runtime bundle to carry alongside it) into `components/` — the
//      single source of truth, no wrapper to keep in sync,
//   5. emits one `@dsCard` preview HTML per component (embedding the real
//      `<kit-*>` tag) and a `manifest.json` mapping tag → source + preview.
//
// Everything under `components/` and `previews/` plus the derived `styles/*`
// are build outputs (gitignored); the committed source is this generator, the
// hand-authored `styles/bridge.css` + `styles/fonts.css`, and the fonts.
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const kitDir = resolve(repoRoot, 'packages/blueprints/kit');
const stylesDir = resolve(here, 'styles');
const componentsDir = resolve(here, 'components');
const previewsDir = resolve(here, 'previews');
for (const d of [stylesDir, componentsDir, previewsDir]) mkdirSync(d, { recursive: true });

// 1. Token CSS — the full :root + per-theme + per-density var blocks.
const { toCss } = await import(resolve(repoRoot, 'packages/design-tokens/dist/index.js'));
writeFileSync(resolve(stylesDir, 'tokens.css'), toCss());
console.log('[build] wrote styles/tokens.css');

// 2. The canonical kit stylesheet — copied verbatim, never edited here.
copyFileSync(resolve(kitDir, 'kit.css'), resolve(stylesDir, 'kit.css'));
console.log('[build] copied styles/kit.css');

// 3. The flat cssEntry the converter copies into _ds_bundle.css. Concatenated
// (not @import'd). Order: tokens define the vars → fonts register @font-face →
// bridge maps token vars onto the kit's app-level contract → kit.css (reads
// those vars) last.
const parts = ['tokens.css', 'fonts.css', 'bridge.css', 'kit.css'].map(
  (f) => `/* ==== ${f} ==== */\n${readFileSync(resolve(stylesDir, f), 'utf8')}`,
);
writeFileSync(resolve(stylesDir, 'bundle.css'), parts.join('\n\n'));
console.log('[build] wrote styles/bundle.css (cssEntry)');

// 4. The REAL component source — no wrapper. Copied so the sync bundle is
// self-contained; the file is the same one the product ships. Dependency-free
// (no vendored runtime bundle to copy alongside it).
copyFileSync(resolve(kitDir, 'elements.js'), resolve(componentsDir, 'elements.js'));
console.log('[build] copied components/elements.js');

// 5. One preview + manifest entry per ported component. Each preview embeds the
// real custom element with example attributes (arrays/objects pass as JSON
// attributes — the elements' default converter parses them), links the CSS
// bundle, and loads the component module so claude.ai/design renders a live card.
const COMPONENTS = [
  {
    tag: 'kit-avatar',
    name: 'Avatar',
    group: 'Brand',
    subtitle: 'Letter avatar — hashed hue, or pinned color/initials',
    viewport: { width: 380, height: 120 },
    body: `<div style="display:flex;gap:12px;align-items:center">
  <kit-avatar name="Ada Lovelace"></kit-avatar>
  <kit-avatar name="Grace Hopper" size="3rem"></kit-avatar>
  <kit-avatar name="Katherine Johnson" shape="rounded"></kit-avatar>
  <kit-avatar name="You" initials="You" color="#0FA678" size="2.5rem"></kit-avatar>
</div>`,
  },
  {
    tag: 'kit-meter',
    name: 'Meter',
    group: 'Data',
    subtitle: 'Slim proportion bar — default / warn / danger / ok',
    viewport: { width: 320, height: 170 },
    body: `<div style="display:flex;flex-direction:column;gap:12px;width:240px">
  <kit-meter ratio="0.4"></kit-meter>
  <kit-meter ratio="0.72" tone="warn"></kit-meter>
  <kit-meter ratio="0.95" tone="danger"></kit-meter>
  <kit-meter ratio="0.85" tone="ok"></kit-meter>
</div>`,
  },
  {
    tag: 'kit-line-chart',
    name: 'LineChart',
    group: 'Data',
    subtitle: 'Trend line with area fill + last-point dot',
    viewport: { width: 520, height: 200 },
    body: `<kit-line-chart
  width="480"
  height="160"
  points='[{"x":0,"y":3},{"x":1,"y":5},{"x":2,"y":4},{"x":3,"y":8},{"x":4,"y":6},{"x":5,"y":11}]'
></kit-line-chart>`,
  },
  {
    tag: 'kit-bar-chart',
    name: 'BarChart',
    group: 'Data',
    subtitle: 'Vertical bars with tick labels (muted variant)',
    viewport: { width: 520, height: 200 },
    body: `<kit-bar-chart
  width="480"
  height="160"
  items='[{"label":"Jan","value":412},{"label":"Feb","value":1650},{"label":"Mar","value":88},{"label":"Apr","value":214,"muted":true}]'
></kit-bar-chart>`,
  },
  {
    tag: 'kit-skeleton',
    name: 'Skeleton',
    group: 'Feedback',
    subtitle: 'Shimmer placeholder rows',
    viewport: { width: 320, height: 160 },
    body: `<div style="width:260px"><kit-skeleton rows="4"></kit-skeleton></div>`,
  },
  {
    tag: 'kit-toast',
    name: 'Toast',
    group: 'Feedback',
    subtitle: 'Outcome toast — neutral / accent / danger, with Undo',
    viewport: { width: 420, height: 200 },
    body: `<div style="display:flex;flex-direction:column;gap:10px;width:340px">
  <kit-toast text="Saved to your vault"></kit-toast>
  <kit-toast text="Note archived" tone="accent" undo-label="Undo"></kit-toast>
  <kit-toast text="The vault refused that write" tone="danger"></kit-toast>
</div>`,
  },
  {
    tag: 'kit-mention-chip',
    name: 'MentionChip',
    group: 'References',
    subtitle: 'Inline @-mention chip resolving a vault entity',
    viewport: { width: 360, height: 120 },
    body: `<p style="font:15px var(--sans,sans-serif);color:var(--text,#111);max-width:320px">
  Met with <kit-mention-chip card='{"type":"core.party","title":"Ada Lovelace","status":"live"}'></kit-mention-chip>
  about <kit-mention-chip card='{"type":"knowledge.note","title":"Analytical Engine","status":"live"}'></kit-mention-chip>.
</p>`,
  },
  {
    tag: 'kit-reference-strip',
    name: 'ReferenceStrip',
    group: 'References',
    subtitle: 'Cross-reference tiles with status + anchored flag',
    viewport: { width: 480, height: 160 },
    body: `<kit-reference-strip
  refs='[{"link_id":"a","card":{"type":"core.party","title":"Ada Lovelace","subtitle":"Mathematician","status":"live"},"selector":{}},{"link_id":"b","card":{"type":"media.media_asset","title":"Portrait","status":"trashed"}},{"link_id":"c","card":{"type":"knowledge.note","status":"missing"}}]'
></kit-reference-strip>`,
  },
];

/** First-line @dsCard marker the Design System pane indexes on. */
function previewHtml(c) {
  const { width, height } = c.viewport;
  const indentedBody = c.body
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  return `<!-- @dsCard group="${c.group}" name="${c.name}" subtitle="${c.subtitle}" width="${width}" height="${height}" -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="../styles/bundle.css" />
    <script type="module" src="../components/elements.js"></script>
    <style>
      body {
        margin: 0;
        padding: 24px;
        background: var(--bg-app, #fff);
        color: var(--text, #111);
      }
    </style>
  </head>
  <body>
${indentedBody}
  </body>
</html>
`;
}

rmSync(previewsDir, { recursive: true, force: true });
mkdirSync(previewsDir, { recursive: true });
for (const c of COMPONENTS) {
  writeFileSync(resolve(previewsDir, `${c.tag}.html`), previewHtml(c));
}
console.log(`[build] wrote ${COMPONENTS.length} preview cards → previews/`);

// The manifest: tag → real source module + preview. This is what replaces the
// former React wrapper index — it points straight at the ported component
// files, so there is nothing to keep in sync by hand.
const manifest = {
  source: 'components/elements.js',
  cssEntry: 'styles/bundle.css',
  components: COMPONENTS.map((c) => ({
    tag: c.tag,
    name: c.name,
    group: c.group,
    subtitle: c.subtitle,
    preview: `previews/${c.tag}.html`,
  })),
};
writeFileSync(resolve(here, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('[build] wrote manifest.json');
