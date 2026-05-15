import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCss } from '@centraid/design-tokens';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Templates ship inside @centraid/openclaw-plugin/templates. */
const PLUGIN_TEMPLATES = path.resolve(HARNESS_DIR, '..', '..', 'openclaw-plugin', 'templates');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Validate an app id against centraid's reserved-prefix and shape rules. */
export function validateAppId(id: string): void {
  if (id.startsWith('_') || !ID_RE.test(id)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid app id "${id}". Lowercase a-z / 0-9 / "-", 1-63 chars, no leading "_".`,
    );
  }
}

/**
 * Scaffold a new project folder under `<projectsDir>/<id>/` with a minimal
 * centraid-format layout: index.html stub, package.json, tsconfig.json,
 * empty queries/actions/crons dirs, and an app.json.
 */
export async function scaffoldProject(
  projectsDir: string,
  id: string,
  opts: { name?: string; description?: string; version?: string } = {},
): Promise<ProjectInfo> {
  validateAppId(id);
  const dir = path.join(projectsDir, id);
  if (await exists(dir)) {
    throw new HarnessError('already_exists', `Project "${id}" already exists at ${dir}.`);
  }
  await fs.mkdir(dir, { recursive: true });

  // Copy the plugin's per-app package.json template. There is no tsconfig
  // — handlers are .js with JSDoc, no compile step.
  await copyPluginTemplate('app-package.json', path.join(dir, 'package.json'), (raw) =>
    raw.replace('"name": "centraid-app-example"', `"name": "centraid-app-${id}"`),
  );

  const appJson: Record<string, unknown> = {
    name: opts.name ?? id,
    version: opts.version ?? '0.1.0',
  };
  if (opts.description?.trim()) appJson.description = opts.description.trim();
  await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify(appJson, null, 2) + '\n');

  await fs.writeFile(path.join(dir, 'index.html'), DEFAULT_INDEX_HTML(id, opts.name ?? id));
  // tokens.css is a frozen snapshot of @centraid/design-tokens at
  // scaffold time — apps stay self-contained. If the shell tokens
  // evolve, re-running scaffold (or a future `centraid tokens sync`)
  // regenerates it; in the meantime nothing in an authored app drifts.
  await fs.writeFile(path.join(dir, 'tokens.css'), toCss());
  await fs.writeFile(path.join(dir, 'app.css'), DEFAULT_APP_CSS);
  await fs.writeFile(path.join(dir, 'app.js'), DEFAULT_APP_JS);
  await fs.writeFile(path.join(dir, 'theme-bridge.js'), THEME_BRIDGE_JS);

  await fs.mkdir(path.join(dir, 'queries'));
  await fs.mkdir(path.join(dir, 'actions'));
  await fs.mkdir(path.join(dir, 'crons'));
  await fs.mkdir(path.join(dir, 'migrations'));

  // README so the human/agent has a clear starting brief in-folder.
  await fs.writeFile(path.join(dir, 'README.md'), README_TEMPLATE(id));

  const stat = await fs.stat(dir);
  return {
    id,
    dir,
    built: false,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** List existing projects under projectsDir. */
export async function listProjects(projectsDir: string): Promise<ProjectInfo[]> {
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(projectsDir, e.name);
    const stat = await fs.stat(dir);
    const [built, meta, hasIndex] = await Promise.all([
      hasAnyBuiltJs(dir),
      readAppMeta(dir),
      fileExists(path.join(dir, 'index.html')),
    ]);
    out.push({
      id: e.name,
      dir,
      built,
      modifiedAt: stat.mtime.toISOString(),
      name: meta.name,
      description: meta.description,
      hasIndex,
    });
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

/**
 * Patch a project's `app.json` with new `name` and/or `description`.
 * Preserves all other fields and creates the file if it doesn't exist
 * (older scaffolds may pre-date the requirement). The directory layout
 * isn't touched — `id` stays the directory name.
 *
 * - Empty/whitespace `name` is rejected (name is mandatory).
 * - Empty/whitespace `description` clears the field.
 */
export async function updateProjectMeta(
  projectsDir: string,
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  validateAppId(id);
  const dir = path.join(projectsDir, id);
  const appJsonPath = path.join(dir, 'app.json');
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(appJsonPath, 'utf8');
    const decoded = JSON.parse(raw) as unknown;
    if (decoded && typeof decoded === 'object') parsed = decoded as Record<string, unknown>;
  } catch {
    /* fall through: write a fresh app.json */
  }
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) {
      throw new HarnessError('invalid_id', 'Project name cannot be empty.');
    }
    parsed.name = trimmed;
  }
  if (patch.description !== undefined) {
    const trimmed = patch.description.trim();
    if (trimmed) parsed.description = trimmed;
    else delete parsed.description;
  }
  await fs.writeFile(appJsonPath, JSON.stringify(parsed, null, 2) + '\n');
}

/** Best-effort read of `app.json#{name,description}`. Both may be undefined. */
async function readAppMeta(projectDir: string): Promise<{ name?: string; description?: string }> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; description?: unknown };
    const name =
      typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    const description =
      typeof parsed.description === 'string' && parsed.description.length > 0
        ? parsed.description
        : undefined;
    return { name, description };
  } catch {
    return {};
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively delete a project directory. Refuses to act outside `projectsDir`
 * so a malformed `id` can't escalate into deleting unrelated paths.
 */
export async function deleteProject(projectsDir: string, id: string): Promise<void> {
  validateAppId(id);
  const projectsRoot = path.resolve(projectsDir);
  const target = path.resolve(projectsRoot, id);
  if (!target.startsWith(projectsRoot + path.sep) && target !== projectsRoot) {
    throw new HarnessError('no_project', `Refusing to delete path outside projects dir: ${target}`);
  }
  if (target === projectsRoot) {
    throw new HarnessError('no_project', `Refusing to delete the projects root.`);
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function hasAnyBuiltJs(projectDir: string): Promise<boolean> {
  for (const sub of ['queries', 'actions', 'crons']) {
    const dir = path.join(projectDir, sub);
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.some((n) => n.endsWith('.js') || n.endsWith('.mjs'))) return true;
  }
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyPluginTemplate(
  name: string,
  dest: string,
  transform?: (raw: string) => string,
): Promise<void> {
  const src = path.join(PLUGIN_TEMPLATES, name);
  const raw = await fs.readFile(src, 'utf8');
  await fs.writeFile(dest, transform ? transform(raw) : raw);
}

// The scaffold's index.html wires the visual contract: theme bridge
// loads synchronously before paint, then tokens.css (the design-tokens
// snapshot), then app.css (per-app styles built on top). This is the
// shape every centraid app should keep — the agent's system prompt
// reinforces it.
const DEFAULT_INDEX_HTML = (id: string, name: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <title>${escapeHtml(name)}</title>
    <script src="theme-bridge.js"></script>
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

// app.css is the per-app styling layer built on top of tokens.css. It
// ships utility classes (.head, .add-bar, .list, .row, .empty, etc.)
// matching the "Component primitives" block in the agent prompt — so a
// model that follows the prompt examples gets working UI immediately.
//
// Rules baked in here:
//   - No hex literals; every color is `var(--…)` from tokens.css.
//   - Hit targets ≥ 44px via min-height on inputs/buttons/circle.
//   - `:focus-visible` outlines preserved with `var(--accent)`.
//   - `prefers-reduced-motion` respected.
//   - Mobile-first with one breakpoint at 720px.
const DEFAULT_APP_CSS = `* { box-sizing: border-box; }

body {
  margin: 0;
  padding: max(1rem, env(safe-area-inset-top)) 1rem env(safe-area-inset-bottom);
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

main {
  max-width: 36rem;
  margin: 0 auto;
  padding: 0.5rem 0 2rem;
}

@media (min-width: 720px) {
  body { padding: 1.5rem 2rem; }
  main { max-width: 56rem; }
}

/* --- Page header --- */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.head h1 {
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 0.1rem;
}
.muted { color: var(--ink-3); font-size: 0.85rem; margin: 0; }
.small { font-size: 0.8rem; }

/* --- Surface / card --- */
.surface {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 1rem 1.125rem;
}

/* --- Inputs --- */
input[type='text'], input[type='search'], textarea {
  flex: 1;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-elev);
  color: var(--ink);
  font: inherit;
  font-size: 1rem;
  -webkit-appearance: none;
}
input:focus-visible, textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
}

/* --- Buttons --- */
button { font: inherit; cursor: pointer; }
.primary {
  min-height: 2.75rem;
  padding: 0 1.125rem;
  border-radius: var(--r-md);
  border: none;
  background: var(--accent);
  color: var(--ink-inv, #fff);
  font-weight: 600;
  font-size: 0.9375rem;
  -webkit-tap-highlight-color: transparent;
}
.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ghost {
  min-height: 2.75rem;
  padding: 0 0.875rem;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-2);
  font-weight: 500;
}
.ghost:hover { background: var(--bg-elev); }
.ghost:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.link {
  background: none; border: none; padding: 0;
  color: var(--accent); text-decoration: underline; font: inherit;
}

/* --- Bars (input + button paired) --- */
.add-bar { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; }

/* --- Lists --- */
.list { display: flex; flex-direction: column; gap: 0.25rem; }
.row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--line);
}
.row:last-child { border-bottom: none; }
.row-text { flex: 1; min-width: 0; font-size: 0.95rem; line-height: 1.35; word-break: break-word; }
.row[data-done='true'] .row-text { color: var(--ink-4); text-decoration: line-through; }

/* --- Circle toggle (used inside list rows) --- */
.circle {
  width: 1.75rem; height: 1.75rem;
  min-width: 1.75rem;
  border-radius: 50%;
  border: 1.5px solid var(--ink-4);
  background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  color: var(--ink-inv, #fff);
  -webkit-tap-highlight-color: transparent;
}
.circle[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); }
.circle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* --- Quiet icon button (e.g. row delete) --- */
.del {
  background: transparent; border: none;
  width: 2.25rem; height: 2.25rem;
  border-radius: var(--r-sm);
  color: var(--ink-4);
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
}
.del:hover { color: var(--ink-2); }
.del:active { color: var(--danger); }
.del:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* --- State triad --- */
.empty { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 2rem 0; }
.loading { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 1rem 0; }
.error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  border-radius: var(--r-md);
  padding: 0.625rem 0.875rem;
  font-size: 0.9rem;
}

/* --- Motion --- */
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`;

const DEFAULT_APP_JS = `// Runs in the browser. Hit your queries via fetch.
//   const rows = await fetch('_data/list-things').then(r => r.json());
//
// Remember the state triad: render Empty / Loading / Error views for
// every async surface. Toggle elements via the \`hidden\` attribute so
// screen readers don't announce all three at once.
`;

// theme-bridge.js — synchronous, runs before paint. Reads initial
// theme from the URL hash the shell appends to the iframe src, then
// listens for `centraid:theme` postMessages so the iframe re-tunes
// when the user flips dark/light or drags the Dark-shade slider.
// Must be loaded with a plain <script> (no type=module, no defer).
const THEME_BRIDGE_JS = `(function () {
  var h = document.documentElement;
  function apply(theme, bgL) {
    if (theme === 'dark' || theme === 'light') h.dataset.theme = theme;
    if (bgL != null && bgL !== '') h.style.setProperty('--bg-l', bgL + '%');
  }
  try {
    var p = new URLSearchParams((location.hash || '').slice(1));
    apply(p.get('theme'), p.get('bgL'));
  } catch (_) { /* noop */ }
  addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'centraid:theme') return;
    apply(d.theme, d.bgL);
  });
})();
`;

const README_TEMPLATE = (id: string): string => `# ${id}

Centraid app project. Files here are the source for the published app.

## Author handlers in JavaScript

Handlers are \`.js\` ES modules. There is no build step — the runtime loads
them directly. Type-check via JSDoc annotations:

\`\`\`js
/** @type {import('@centraid/openclaw-plugin').QueryHandler} */
export default async ({ query, db }) => { /* ... */ };
\`\`\`

For editor IntelliSense, run \`bun install\` once so the type package
resolves locally:

\`\`\`sh
bun install   # or: npm install
\`\`\`

## Layout

- \`index.html\`, \`app.css\`, \`app.js\` — static, served from \`/centraid/${id}/\`
- \`queries/<name>.js\` — GET \`/centraid/${id}/_data/<name>\`
- \`actions/<name>.js\` — POST \`/centraid/${id}/_run\` (body picks \`action\`)
- \`crons/<name>.js\` — schedule + agent task + ingest handler in one module
- \`migrations/NNNN_<slug>.sql\` — schema migrations applied on publish
- \`app.json\` — metadata (\`name\`, \`version\`)

See \`@centraid/openclaw-plugin\` for the full handler-arg types.
`;

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
