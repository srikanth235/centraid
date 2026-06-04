/*
 * Filesystem-free app scaffolding (issue #141).
 *
 * The desktop no longer owns a local workspace dir — app code lives in
 * the gateway's git store, edited over HTTP. So the scaffold/clone/rename
 * flows can't write to a directory; they produce a **file map**
 * (`{path, content}[]`) the caller PUTs into a git-store session and
 * publishes. These pure builders hold the content templates; the
 * filesystem helpers in `scaffold.ts` wrap them and write to disk for the
 * CLI / local paths.
 */

import { toCss } from '@centraid/design-tokens';
import { rewriteTitleInHtml, applyManifestName } from './app-rewrites.js';
import { AUTOMATIONS_README, DEFAULT_APP_CSS, README_TEMPLATE } from './scaffold-defaults.js';
import { AppScaffoldError } from './scaffold-types.js';

/** A single file in a scaffold/clone file map. `path` is app-relative, posix. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

// A plain filesystem-safe slug. Automation apps are marked by the
// manifest's `kind` field, not a dotted `auto.` id prefix (issue #98), so
// no dot is allowed — a tree-traversing `..` is impossible by construction.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Validate an app id against centraid's reserved-prefix and shape rules. */
export function validateAppId(id: string): void {
  if (id.startsWith('_') || !ID_RE.test(id)) {
    throw new AppScaffoldError(
      'invalid_id',
      `Invalid app id "${id}". Lowercase a-z / 0-9 / "-", 1-63 chars, no leading "_".`,
    );
  }
}

export interface ScaffoldAppOpts {
  name?: string;
  description?: string;
  version?: string;
}

/**
 * Build the file map for a fresh app (issue #141): package.json,
 * app.json (the manifest), index.html, tokens.css (a frozen
 * design-tokens snapshot), app.css, app.js, README.md, and the
 * automations/ brief. The git store tracks files, so empty canonical
 * subdirs (queries/actions/migrations) are not emitted — they appear
 * once the agent writes the first handler.
 */
export function scaffoldAppFiles(id: string, opts: ScaffoldAppOpts = {}): ScaffoldFile[] {
  validateAppId(id);
  const name = opts.name ?? id;
  const appJson: Record<string, unknown> = {
    manifestVersion: 1,
    id,
    name,
    version: opts.version ?? '0.1.0',
    ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
    actions: [],
    queries: [],
    knobs: DEFAULT_APP_KNOBS,
  };
  return [
    { path: 'package.json', content: appPackageJson(id) },
    { path: 'app.json', content: JSON.stringify(appJson, null, 2) + '\n' },
    { path: 'index.html', content: DEFAULT_INDEX_HTML(id, name) },
    { path: 'tokens.css', content: toCss() },
    { path: 'app.css', content: DEFAULT_APP_CSS },
    { path: 'app.js', content: DEFAULT_APP_JS },
    { path: 'automations/README.md', content: AUTOMATIONS_README },
    { path: 'README.md', content: README_TEMPLATE(id) },
  ];
}

/**
 * Apply a `{name?, description?}` patch over an app's current draft
 * files (issue #141), returning ONLY the files that changed (app.json
 * plus, on rename, index.html `<title>` and any
 * automations/<id>/automation.json#name). Mirrors the filesystem
 * `updateAppMeta` behavior without touching disk.
 *
 * - Empty/whitespace `name` is rejected (name is mandatory).
 * - Empty/whitespace `description` clears the field.
 * - `existingNames` is the set of sibling apps (id + display name, e.g.
 *   from `listAppsWithMeta()`) for the case-insensitive duplicate-name
 *   guard; the app's own id is excluded by the caller or by id match.
 */
export function updateAppMetaFiles(
  current: ScaffoldFile[],
  id: string,
  patch: { name?: string; description?: string },
  existingNames: ReadonlyArray<{ id: string; name?: string }> = [],
): ScaffoldFile[] {
  validateAppId(id);
  const byPath = new Map(current.map((f) => [f.path, f.content]));
  const renameTo = patch.name === undefined ? undefined : patch.name.trim();
  if (patch.name !== undefined && !renameTo) {
    throw new AppScaffoldError('invalid_id', 'App name cannot be empty.');
  }
  if (renameTo) {
    const taken = existingNames.some(
      (a) => a.id !== id && (a.name ?? '').trim().toLowerCase() === renameTo.toLowerCase(),
    );
    if (taken)
      throw new AppScaffoldError('already_exists', `An app named "${renameTo}" already exists.`);
  }

  let parsed: Record<string, unknown> = {};
  const rawAppJson = byPath.get('app.json');
  if (rawAppJson) {
    try {
      const decoded = JSON.parse(rawAppJson) as unknown;
      if (decoded && typeof decoded === 'object') parsed = decoded as Record<string, unknown>;
    } catch {
      /* fall through: write a fresh app.json */
    }
  }
  if (renameTo) parsed.name = renameTo;
  if (patch.description !== undefined) {
    const trimmed = patch.description.trim();
    if (trimmed) parsed.description = trimmed;
    else delete parsed.description;
  }

  const changed: ScaffoldFile[] = [
    { path: 'app.json', content: JSON.stringify(parsed, null, 2) + '\n' },
  ];
  // Propagate the rename to subordinate files (browser-tab <title>,
  // Automations row title) so they don't drift from app.json#name. The
  // rename path leaves `generated.{by,at}` alone (clone-only).
  if (renameTo !== undefined) {
    const html = byPath.get('index.html');
    if (html !== undefined) {
      const next = rewriteTitleInHtml(html, renameTo);
      if (next !== html) changed.push({ path: 'index.html', content: next });
    }
    for (const f of current) {
      if (!/^automations\/[^/]+\/automation\.json$/.test(f.path)) continue;
      const next = applyManifestName(f.content, renameTo);
      if (next !== null && next !== f.content) changed.push({ path: f.path, content: next });
    }
  }
  return changed;
}

/** The per-app package.json a fresh app ships (no compile step). */
export function appPackageJson(id: string): string {
  return (
    JSON.stringify(
      {
        name: `centraid-app-${id}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        devDependencies: { '@centraid/openclaw-plugin': '*' },
      },
      null,
      2,
    ) + '\n'
  );
}

// The scaffold's index.html wires the visual contract: an inline live-
// settings bridge runs synchronously before paint, then tokens.css (the
// design-tokens snapshot), then app.css (per-app styles built on top).
const DEFAULT_INDEX_HTML = (id: string, name: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <title>${escapeHtml(name)}</title>
    <script>${INLINE_SETTINGS_BRIDGE}</script>
    <link rel="stylesheet" href="tokens.css" />
    <link rel="stylesheet" href="app.css" />
  </head>
  <body>
    <main>
      <header class="head">
        <h1>${escapeHtml(name)}</h1>
        <p class="muted">App id: <code>${escapeHtml(id)}</code></p>
      </header>
      <section class="surface" aria-label="Get started">
        <p>Edit <code>index.html</code>, add queries under <code>queries/</code>, and the agent will reshape this scaffold into your app.</p>
      </section>
    </main>
    <script type="module" src="app.js"></script>
  </body>
</html>
`;

const DEFAULT_APP_JS = `// Runs in the browser. Invoke handlers via the three-tool surface
// exposed on window.centraid:
//   const rows = await window.centraid.read({ query: 'list-things' });
//   await window.centraid.write({ action: 'add-thing', input: { name } });
//
// Remember the state triad: render Empty / Loading / Error views for
// every async surface. Toggle elements via the \`hidden\` attribute so
// screen readers don't announce all three at once.
`;

// Default per-app knob list embedded in every new app's `app.json`
// (under `knobs[]`). Surfaces in the desktop's "App settings" gear
// popover: font, page width, corner radius, and accent colour.
const DEFAULT_APP_KNOBS: ReadonlyArray<Record<string, unknown>> = [
  {
    key: 'appFont',
    label: 'Font',
    type: 'segmented',
    default: 'sans',
    options: [
      { value: 'sans', label: 'Sans' },
      { value: 'serif', label: 'Serif' },
      { value: 'mono', label: 'Mono' },
    ],
  },
  {
    key: 'appWidth',
    label: 'Width',
    type: 'segmented',
    default: 'narrow',
    options: [
      { value: 'narrow', label: 'Narrow' },
      { value: 'wide', label: 'Wide' },
    ],
  },
  {
    key: 'appRadius',
    label: 'Corners',
    type: 'segmented',
    default: 'rounded',
    options: [
      { value: 'sharp', label: 'Sharp' },
      { value: 'rounded', label: 'Rounded' },
      { value: 'pill', label: 'Pill' },
    ],
  },
  {
    key: 'appColor',
    label: 'Color',
    type: 'swatch',
    default: '#4950F6',
    options: [
      { value: '#4950F6', label: 'Blue' },
      { value: '#7C5BD9', label: 'Violet' },
      { value: '#2EA098', label: 'Teal' },
      { value: '#B47B3F', label: 'Ochre' },
      { value: '#E55772', label: 'Rose' },
    ],
  },
];

// Inline settings bridge — emitted inside a synchronous <script> in the
// scaffolded index.html. Covers two extras beyond the runtime's baked
// initial paint: (1) builder-preview URL-hash fallback, (2) live
// postMessage updates while the iframe is mounted in the shell.
const INLINE_SETTINGS_BRIDGE = `(function(){var h=document.documentElement;function aT(t,b){if(t==='dark'||t==='light')h.dataset.theme=t;if(b!=null&&b!=='')h.style.setProperty('--bg-l',b+'%');}function aS(s){if(s.dataAttrs)for(var k in s.dataAttrs)h.setAttribute('data-'+k,s.dataAttrs[k]);if(s.cssVars)for(var k in s.cssVars)h.style.setProperty('--'+k,s.cssVars[k]);}try{var p=new URLSearchParams((location.hash||'').slice(1));aT(p.get('theme'),p.get('bgL'));}catch(_){}addEventListener('message',function(e){var d=e&&e.data;if(!d)return;if(d.type==='centraid:settings')aS(d);else if(d.type==='centraid:theme')aT(d.theme,d.bgL);});})();`;

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
