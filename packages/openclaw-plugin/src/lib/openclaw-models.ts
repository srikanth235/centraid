/*
 * OpenClaw model enumeration for runner-status.
 *
 * Shells out to the stable CLI surface — `openclaw models list --json` —
 * and maps the configured-model catalog into `RunnerModel[]` for the chat
 * model picker. We use the CLI (rather than an in-process catalog read) so
 * the plugin tracks whatever the user's `openclaw` build reports, with no
 * coupling to internal catalog APIs.
 *
 * Enumeration is best-effort: any failure (binary missing, non-zero exit,
 * unparseable JSON, timeout) resolves to `[]` so runner-status never breaks
 * just because the model list couldn't be fetched.
 */

import { execFile } from 'node:child_process';
import type { RunnerModel } from '@centraid/app-engine';

/** `openclaw models list` is a local config/catalog read — keep the cap short. */
const LIST_TIMEOUT_MS = 6_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface OpenClawModelEntry {
  key?: unknown;
  name?: unknown;
  tags?: unknown;
}

/**
 * Run `openclaw models list --json` and return the configured models.
 * Inherits the current process env so the same profile / state dir
 * (OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH) the plugin runs under is used.
 */
export function listOpenClawModels(): Promise<RunnerModel[]> {
  return new Promise((resolve) => {
    execFile(
      'openclaw',
      ['models', 'list', '--json'],
      { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseModelsJson(stdout));
      },
    );
  });
}

/** Parse the `{ models: [{ key, name, tags }] }` body into RunnerModel[]. */
export function parseModelsJson(stdout: string): RunnerModel[] {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entries = (body as { models?: unknown }).models;
  if (!Array.isArray(entries)) return [];
  const models: RunnerModel[] = [];
  for (const raw of entries as OpenClawModelEntry[]) {
    if (!raw || typeof raw.key !== 'string' || !raw.key) continue;
    const model: RunnerModel = { id: raw.key };
    if (typeof raw.name === 'string' && raw.name) model.name = raw.name;
    if (Array.isArray(raw.tags) && raw.tags.includes('default')) model.default = true;
    models.push(model);
  }
  return models;
}
