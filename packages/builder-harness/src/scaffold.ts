import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCss } from '@centraid/design-tokens';
import { DEFAULT_APP_CSS } from './scaffold-defaults.js';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Templates ship inside @centraid/openclaw-plugin/templates. */
const PLUGIN_TEMPLATES = path.resolve(HARNESS_DIR, '..', '..', 'openclaw-plugin', 'templates');

// Dots are permitted so an automation app can carry the `auto.` prefix
// (issue #98); a `..` sequence is still rejected as path-unsafe.
const ID_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** Validate an app id against centraid's reserved-prefix and shape rules. */
export function validateAppId(id: string): void {
  if (id.startsWith('_') || id.includes('..') || !ID_RE.test(id)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid app id "${id}". Lowercase a-z / 0-9 / "-" / ".", 1-63 chars, no leading "_".`,
    );
  }
}

/**
 * Scaffold a new project folder under `<projectsDir>/<id>/` with a minimal
 * centraid-format layout: index.html stub, package.json, tsconfig.json,
 * empty queries/actions dirs, and an app.json.
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
  // Default per-app knob manifest. Gives every from-scratch project the
  // Notion-style settings popover for free; the author can add or remove
  // rows later by editing this file directly. The runtime routes any
  // `app*` key dynamically (see runtime-core/settings-merge.ts) so new
  // knobs added here don't need a runtime change — just matching CSS
  // rules in `app.css`.
  await fs.writeFile(path.join(dir, 'app-knobs.json'), DEFAULT_APP_KNOBS);

  // Canonical centraid subdirs. `automations/` holds one .json manifest
  // per cron-scheduled automation (see runtime-core's
  // `automation-manifest.ts`); the runtime artifact — the generated .js
  // handler — lives next to user-authored actions under `actions/` so
  // author-side tooling treats them uniformly. Kept in sync with
  // `clone.ts#CANONICAL_SUBDIRS` so cloned projects match fresh ones.
  for (const sub of ['queries', 'actions', 'migrations', 'automations']) {
    await fs.mkdir(path.join(dir, sub));
  }
  // Seed automations/ with a brief so empty-dir file viewers don't hide
  // it and the agent has an in-folder pointer to the manifest shape.
  await fs.writeFile(path.join(dir, 'automations', 'README.md'), AUTOMATIONS_README);

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
  // Note: the automation handler is generated under `actions/`, so it's
  // already covered by the actions scan below. The `automations/` folder
  // itself only holds manifests, not executable code — no need to scan it.
  for (const sub of ['queries', 'actions']) {
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

// The scaffold's index.html wires the visual contract: an inline live-
// settings bridge runs synchronously before paint, then tokens.css (the
// design-tokens snapshot), then app.css (per-app styles built on top).
// The runtime bakes initial theme/density/accent into <html …> before
// serving, so the bridge only handles two extras: URL-hash fallback for
// the builder preview path that bypasses the runtime, and postMessage
// for live updates while the iframe is mounted in the shell.
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

const DEFAULT_APP_JS = `// Runs in the browser. Hit your queries via fetch.
//   const rows = await fetch('_data/list-things').then(r => r.json());
//
// Remember the state triad: render Empty / Loading / Error views for
// every async surface. Toggle elements via the \`hidden\` attribute so
// screen readers don't announce all three at once.
`;

// Default per-app knob manifest written into every new project. Surfaces
// in the desktop's "App settings" gear popover: font, page width, corner
// radius, and accent colour. The runtime routes any `app*` key
// dynamically — `appFont`/`appWidth`/`appRadius` become `<html data-app-*>`
// attributes and `appColor` becomes `--app-color` (consumed via
// `var(--app-color, var(--accent))` in CSS). Authors can add/remove
// knobs by editing this file plus the matching CSS in `app.css`.
const DEFAULT_APP_KNOBS =
  JSON.stringify(
    {
      version: 1,
      knobs: [
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
      ],
    },
    null,
    2,
  ) + '\n';

// Inline settings bridge — emitted inside a synchronous <script> in the
// scaffolded index.html. Initial paint values come from the runtime, which
// bakes <html data-theme="…" style="--bg-l:…"> before serving and stamps a
// CSP nonce on this script. This bridge covers two extras:
//   1. Builder preview (centraid-preview://) bypasses the runtime, so we
//      read URL hash params as a fallback for the no-bake path.
//   2. The shell can flip a pref while the iframe is mounted — the
//      postMessage listener accepts both `centraid:settings` (full
//      data-attrs + CSS vars) and the legacy `centraid:theme` shape.
const INLINE_SETTINGS_BRIDGE = `(function(){var h=document.documentElement;function aT(t,b){if(t==='dark'||t==='light')h.dataset.theme=t;if(b!=null&&b!=='')h.style.setProperty('--bg-l',b+'%');}function aS(s){if(s.dataAttrs)for(var k in s.dataAttrs)h.setAttribute('data-'+k,s.dataAttrs[k]);if(s.cssVars)for(var k in s.cssVars)h.style.setProperty('--'+k,s.cssVars[k]);}try{var p=new URLSearchParams((location.hash||'').slice(1));aT(p.get('theme'),p.get('bgL'));}catch(_){}addEventListener('message',function(e){var d=e&&e.data;if(!d)return;if(d.type==='centraid:settings')aS(d);else if(d.type==='centraid:theme')aT(d.theme,d.bgL);});})();`;

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
- \`automations/<name>.json\` — cron-scheduled deterministic action manifest;
  the generated handler lives under \`actions/<name>.js\` and is fired by the
  host scheduler. The manifest is the source of truth; the handler is
  regenerated from the user's prompt and is **not** hand-edited.
- \`migrations/NNNN_<slug>.sql\` — schema migrations applied on publish
- \`app.json\` — metadata (\`name\`, \`version\`)

See \`@centraid/openclaw-plugin\` for the full handler-arg types.
`;

const AUTOMATIONS_README = `# automations/

Cron-scheduled deterministic actions for this app. Drop one \`.json\`
manifest per automation here; the matching handler ships at
\`actions/<name>.js\`. The host scheduler (launchd / Task Scheduler /
systemd timer locally, openclaw cron remotely) fires
\`centraid run-automation\` against each manifest on schedule.

## Manifest shape

\`\`\`json
{
  "prompt": "every 30 min, summarize new PRs in foo/bar",
  "schedule": "*/30 * * * *",
  "action": "summarize-prs.js",
  "requires": {
    "mcps": ["github"],
    "tools": ["github.list_pull_requests"],
    "model": "anthropic/claude-3-5-sonnet"
  },
  "costEstimate": { "model": "anthropic/claude-3-5-sonnet", "tokensPerFire": 5000 },
  "generated": { "by": "builder", "at": "<ISO-8601>" }
}
\`\`\`

- \`schedule\` is a 5-field cron expression (UTC).
- \`requires.mcps\` / \`requires.tools\` declare which host tools the
  handler will call via \`ctx.tool(name, args)\`. Install-time check
  verifies the host has them before activating the schedule.
- \`requires.model\` is the model \`ctx.agent({prompt, json?})\` should
  route through. **Never set this to \`centraid-mock/*\`** — that would
  recurse into the runner.
- \`generated.at\` is an ISO-8601 timestamp.

## Authoring

The prompt is canonical. Re-prompting the builder regenerates the JS
under \`actions/\`. Do not hand-edit the generated handler — your edits
will be overwritten on the next regeneration.

See \`@centraid/openclaw-plugin\`'s \`AutomationHandler\` type for the
full handler-arg shape.
`;

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
