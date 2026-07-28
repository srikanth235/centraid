// Gateway-side app-manifest validation (issue #137; was the agent-harness).
// The publish gate (`publishAndReconcile`) and the apps-store publish route both
// call `validateManifestAt` before a draft goes live, so a structurally-broken
// or replay-unsafe app is rejected at publish time rather than at run/fire time.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ManifestError, parseAppManifest } from '@centraid/app-engine';
import * as automation from '@centraid/automation';

import { fileExists } from './routes/route-helpers.js';

function findFirstInOrder<T, R>(
  values: readonly T[],
  check: (value: T) => R | PromiseLike<R | undefined>,
): Promise<R | undefined> {
  const visit = async (index: number): Promise<R | undefined> => {
    const value = values[index];
    if (value === undefined) return undefined;
    const found = await check(value);
    return found === undefined ? visit(index + 1) : found;
  };
  return visit(0);
}

/**
 * Validate an app dir's `app.json` and the files it declares. Returns a
 * human-readable error string on the first problem, or `undefined` when the app
 * is publishable. Covers: parseable manifest, every declared action/query has
 * its `.js`, and — for automation apps — every `automations/<id>/automation.json`
 * parses against the automation manifest schema and every handler is replay-safe.
 */
export async function validateManifestAt(appDir: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(appDir, 'app.json'), 'utf8');
  } catch {
    return 'app.json is missing';
  }
  let manifest;
  try {
    manifest = parseAppManifest(raw);
  } catch (err) {
    if (err instanceof ManifestError) {
      return `app.json invalid (${err.code})${err.path ? ` at ${err.path}` : ''}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
  const actionError = await findFirstInOrder(manifest.actions, async (action) =>
    (await fileExists(path.join(appDir, 'actions', `${action.name}.js`)))
      ? undefined
      : `app.json declares action "${action.name}" but actions/${action.name}.js does not exist`,
  );
  if (actionError) return actionError;
  const queryError = await findFirstInOrder(manifest.queries, async (query) =>
    (await fileExists(path.join(appDir, 'queries', `${query.name}.js`)))
      ? undefined
      : `app.json declares query "${query.name}" but queries/${query.name}.js does not exist`,
  );
  if (queryError) return queryError;
  // Automation apps carry handlers under `automations/<id>/handler.js` that run
  // under the #166 journal/replay runtime — they must be deterministic between
  // ctx.* calls. Lint each for replay-unsafe patterns (issue #167) so a bad
  // handler is rejected at publish time, not silently mis-resumed at fire time.
  if (manifest.kind === 'automation') {
    // Every `automations/<id>/automation.json` must itself parse against
    // @centraid/automation's manifest schema (trigger shapes, vault scopes,
    // cron exprs, webhook slugs, …). The dedicated POST /centraid/_automations
    // create route already validates this on the way in, but the generic
    // draft file-write route (PUT /centraid/_apps/<id>/files/<path>) — how the
    // builder's trigger editor applies changes — does not, so a malformed
    // edit could otherwise ride straight through publish and only fail later
    // at fire/schedule time. Check before linting handlers so a manifest
    // error surfaces first.
    const manifestError = await validateAutomationManifestsAt(appDir);
    if (manifestError) return manifestError;
    const handlerError = await lintAutomationHandlersAt(appDir);
    if (handlerError) return handlerError;
  }
  return undefined;
}

/**
 * Parse-validate every `automations/<id>/automation.json` in an automation
 * app dir against `@centraid/automation`'s `parseManifest`. Mirrors
 * {@link lintAutomationHandlersAt}'s directory walk. Returns the first
 * manifest's formatted error, or `undefined` when all are valid (or none
 * exist — structural gaps like a missing manifest are a builder concern,
 * not this validator's).
 */
async function validateAutomationManifestsAt(appDir: string): Promise<string | undefined> {
  const automationsDir = path.join(appDir, 'automations');
  let ids: import('node:fs').Dirent[];
  try {
    ids = await fs.readdir(automationsDir, { withFileTypes: true });
  } catch {
    return undefined; // no automations/ dir — nothing to validate
  }
  return findFirstInOrder(
    ids.filter((ent) => ent.isDirectory()),
    async (ent) => {
      const rel = `automations/${ent.name}/${automation.MANIFEST_FILE}`;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(appDir, rel), 'utf8');
      } catch {
        return undefined; // manifest absent — nothing to validate here
      }
      try {
        automation.parseManifest(raw);
      } catch (err) {
        if (err instanceof automation.ManifestError) {
          return `${rel} invalid (${err.code})${err.field ? ` at ${err.field}` : ''}: ${err.message}`;
        }
        return err instanceof Error ? err.message : String(err);
      }
      return undefined;
    },
  );
}

/**
 * Run the replay-safety lint over every `automations/<id>/handler.js` in an
 * automation app dir. Returns the first handler's formatted authoring error,
 * or `undefined` when all handlers are clean (or none exist).
 */
async function lintAutomationHandlersAt(appDir: string): Promise<string | undefined> {
  const automationsDir = path.join(appDir, 'automations');
  let ids: import('node:fs').Dirent[];
  try {
    ids = await fs.readdir(automationsDir, { withFileTypes: true });
  } catch {
    return undefined; // no automations/ dir — nothing to lint
  }
  return findFirstInOrder(
    ids.filter((ent) => ent.isDirectory()),
    async (ent) => {
      const rel = `automations/${ent.name}/${automation.HANDLER_FILE}`;
      let source: string;
      try {
        source = await fs.readFile(path.join(appDir, rel), 'utf8');
      } catch {
        return undefined; // handler absent — manifest validation handles structural gaps
      }
      const findings = automation.lintHandlerSource(source);
      const error = automation.formatHandlerLintError(findings, rel);
      return error || undefined;
    },
  );
}
