// Gateway-side app-manifest validation (issue #137; was the agent-harness).
// The publish gate (`publishAndReconcile`) and the apps-store publish route both
// call `validateManifestAt` before a draft goes live, so a structurally-broken
// or replay-unsafe app is rejected at publish time rather than at run/fire time.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManifestError, parseAppManifest } from '@centraid/app-engine';
import * as automation from '@centraid/automation';
import { fileExists } from './route-helpers.js';

/**
 * Validate an app dir's `app.json` and the files it declares. Returns a
 * human-readable error string on the first problem, or `undefined` when the app
 * is publishable. Covers: parseable manifest, every declared action/query has
 * its `.js`, and — for automation apps — every handler is replay-safe.
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
  for (const a of manifest.actions) {
    if (!(await fileExists(path.join(appDir, 'actions', `${a.name}.js`)))) {
      return `app.json declares action "${a.name}" but actions/${a.name}.js does not exist`;
    }
  }
  for (const q of manifest.queries) {
    if (!(await fileExists(path.join(appDir, 'queries', `${q.name}.js`)))) {
      return `app.json declares query "${q.name}" but queries/${q.name}.js does not exist`;
    }
  }
  // Automation apps carry handlers under `automations/<id>/handler.js` that run
  // under the #166 journal/replay runtime — they must be deterministic between
  // ctx.* calls. Lint each for replay-unsafe patterns (issue #167) so a bad
  // handler is rejected at publish time, not silently mis-resumed at fire time.
  if (manifest.kind === 'automation') {
    const handlerError = await lintAutomationHandlersAt(appDir);
    if (handlerError) return handlerError;
  }
  return undefined;
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
  for (const ent of ids) {
    if (!ent.isDirectory()) continue;
    const rel = `automations/${ent.name}/${automation.HANDLER_FILE}`;
    let source: string;
    try {
      source = await fs.readFile(path.join(appDir, rel), 'utf8');
    } catch {
      continue; // handler absent — manifest validation handles structural gaps
    }
    const findings = automation.lintHandlerSource(source);
    const error = automation.formatHandlerLintError(findings, rel);
    if (error) return error;
  }
  return undefined;
}
