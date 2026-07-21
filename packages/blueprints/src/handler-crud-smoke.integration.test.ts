/**
 * Blueprint-app handler invoke smoke (#496 P7).
 *
 * Exercises every declared action/query by loading the real handler module
 * and asserting `default` is callable — the same invocation shape the runtime
 * uses (`mod.default({ input, query, ctx })`). A handler body replaced with
 * `export default 42` fails. Complements query-handlers.test.ts (deep
 * behavioural checks on a few queries) with a full-surface loadability sweep.
 */
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- browser-JS fixtures intentionally lack TS declarations (#408)
// @ts-nocheck
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const appsRoot = path.resolve(here, '../apps');

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

function handlerPath(appId: string, kind: 'actions' | 'queries', name: string): string | null {
  for (const ext of ['.ts', '.js', '.mjs']) {
    const candidate = path.join(appsRoot, appId, kind, `${name}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  for (const base of [path.join(appsRoot, appId), path.join(appsRoot, appId, 'handlers')]) {
    for (const ext of ['.ts', '.js', '.mjs']) {
      const candidate = path.join(base, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Mock ctx.vault that returns empty rows — enough to prove the handler ran. */
function emptyCtx() {
  return {
    vault: {
      read: async () => ({ rows: [] }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: 'executed', output: {} }),
      search: async () => ({ rows: [] }),
    },
  };
}

/** Relative import so vitest can transform TypeScript handlers (same as query-handlers). */
const importHandler = (absPath: string) => {
  let rel = path.relative(here, absPath);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  // Keep POSIX separators for the dynamic import specifier.
  return import(rel.split(path.sep).join('/'));
};

describe('blueprint handler invoke smoke', () => {
  const apps = listBlueprintApps();

  test('repo ships the expected built-in blueprint apps', () => {
    expect(apps.length).toBeGreaterThanOrEqual(8);
  });

  test.each(apps)(
    '%s: every declared action/query loads and exports a callable default',
    async (appId) => {
      const manifest = loadAppJson(appId);
      const actions = manifest.actions ?? [];
      const queries = manifest.queries ?? [];
      expect(actions.length + queries.length).toBeGreaterThan(0);

      for (const action of actions) {
        const file = handlerPath(appId, 'actions', action.name);
        expect(file, `${appId} action ${action.name} missing handler file`).toBeTruthy();
        const mod = await importHandler(file!);
        expect(
          typeof mod.default,
          `${appId} action ${action.name} default export must be a function (got ${typeof mod.default})`,
        ).toBe('function');
      }

      for (const query of queries) {
        const file = handlerPath(appId, 'queries', query.name);
        expect(file, `${appId} query ${query.name} missing handler file`).toBeTruthy();
        const mod = await importHandler(file!);
        expect(
          typeof mod.default,
          `${appId} query ${query.name} default export must be a function (got ${typeof mod.default})`,
        ).toBe('function');
        // Invoke with an empty vault. Handlers may return empty projections or
        // throw on missing required input — both prove the export is the real
        // callable. A non-function default never gets here.
        try {
          await mod.default({ input: {}, query: {}, ctx: emptyCtx() });
        } catch {
          // Expected for handlers that require specific input fields.
        }
      }
    },
  );
});
