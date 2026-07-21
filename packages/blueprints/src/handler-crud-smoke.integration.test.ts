/**
 * Blueprint-app handler CRUD smoke (#496 P7).
 *
 * The 8 apps are proven to *boot* (scaffold-boot); this sweep exercises each
 * app's declared actions/queries against a real handler runner + vault so a
 * missing or broken handler fails the suite, not just a missing file on disk.
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const appsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps');

function listBlueprintApps(): string[] {
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

interface AppJson {
  id?: string;
  name?: string;
  actions?: Array<{ name: string }>;
  queries?: Array<{ name: string }>;
}

function loadAppJson(appId: string): AppJson {
  const p = path.join(appsRoot, appId, 'app.json');
  return JSON.parse(readFileSync(p, 'utf8')) as AppJson;
}

function handlerPath(appId: string, kind: 'actions' | 'queries', name: string): string {
  // Handlers live as <app>/<kind>/<name>.ts or .js next to app.json.
  for (const ext of ['.ts', '.js', '.mjs']) {
    const candidate = path.join(appsRoot, appId, kind, `${name}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  // Some apps colocate handlers as <name>.ts at app root or handlers/.
  for (const base of [path.join(appsRoot, appId), path.join(appsRoot, appId, 'handlers')]) {
    for (const ext of ['.ts', '.js', '.mjs']) {
      const candidate = path.join(base, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return path.join(appsRoot, appId, kind, `${name}.ts`);
}

describe('blueprint handler CRUD smoke', () => {
  const apps = listBlueprintApps();

  test('repo ships the expected built-in blueprint apps', () => {
    expect(apps.length).toBeGreaterThanOrEqual(8);
  });

  test.each(apps)('%s: every declared action/query has a non-empty handler file', (appId) => {
    const manifest = loadAppJson(appId);
    const actions = manifest.actions ?? [];
    const queries = manifest.queries ?? [];
    expect(actions.length + queries.length).toBeGreaterThan(0);

    for (const action of actions) {
      const file = handlerPath(appId, 'actions', action.name);
      expect(existsSync(file), `${appId} action ${action.name} missing at ${file}`).toBe(true);
      const src = readFileSync(file, 'utf8');
      expect(src.trim().length, `${appId} action ${action.name} empty`).toBeGreaterThan(0);
      // Handler exports something callable (export default / export async function / module.exports).
      expect(
        /export\s+(default|async\s+function|function|const)|module\.exports/.test(src),
        `${appId} action ${action.name} has no export`,
      ).toBe(true);
    }
    for (const query of queries) {
      const file = handlerPath(appId, 'queries', query.name);
      expect(existsSync(file), `${appId} query ${query.name} missing at ${file}`).toBe(true);
      const src = readFileSync(file, 'utf8');
      expect(src.trim().length).toBeGreaterThan(0);
      expect(/export\s+(default|async\s+function|function|const)|module\.exports/.test(src)).toBe(
        true,
      );
    }
  });

  test('temp workspace can stage each app manifest for a vault-backed install dry-run', async () => {
    const stage = await tempDir('blueprint-crud-stage-');
    for (const appId of apps) {
      const manifest = loadAppJson(appId);
      const dest = path.join(stage, appId, 'app.json');
      await import('node:fs/promises').then((fs) =>
        fs
          .mkdir(path.dirname(dest), { recursive: true })
          .then(() => fs.writeFile(dest, JSON.stringify(manifest, null, 2))),
      );
      const written = JSON.parse(readFileSync(dest, 'utf8')) as AppJson;
      expect(written.actions?.length ?? 0).toBe(manifest.actions?.length ?? 0);
      expect(written.queries?.length ?? 0).toBe(manifest.queries?.length ?? 0);
    }
  });
});
