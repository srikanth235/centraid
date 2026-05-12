import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  await fs.writeFile(path.join(dir, 'app.css'), DEFAULT_APP_CSS);
  await fs.writeFile(path.join(dir, 'app.js'), DEFAULT_APP_JS);

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

const DEFAULT_INDEX_HTML = (id: string, name: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(name)}</title>
    <link rel="stylesheet" href="app.css" />
  </head>
  <body>
    <main>
      <h1>${escapeHtml(name)}</h1>
      <p>App id: <code>${escapeHtml(id)}</code></p>
      <p>This is a placeholder. Edit <code>index.html</code>, add queries under <code>queries/</code>, etc.</p>
    </main>
    <script type="module" src="app.js"></script>
  </body>
</html>
`;

const DEFAULT_APP_CSS = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 2rem; }
main { max-width: 60rem; margin: 0 auto; }
`;

const DEFAULT_APP_JS = `// Runs in the browser. Hit your queries via fetch.
//   const rows = await fetch('_data/list-things').then(r => r.json());
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
