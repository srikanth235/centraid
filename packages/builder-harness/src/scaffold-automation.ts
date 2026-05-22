/**
 * Scaffold a new automation app (issue #98 unified folder model).
 *
 * An automation is never standalone — it is one app folder under
 * `appsDir`, an *automation app*: an `auto.`-prefixed folder with an
 * `app.json` and exactly one automation under `automations/<id>/`. It
 * carries no UI assets. This module writes the minimal layout the
 * builder agent then fills in:
 *
 *   <appsDir>/<appId>/app.json                              — app metadata
 *   <appsDir>/<appId>/automations/<autoId>/automation.json  — the manifest
 *   <appsDir>/<appId>/automations/<autoId>/handler.js       — the handler
 *
 * The automation's globally-unique handle is `<appId>/<autoId>`. The
 * builder agent rewrites `automation.json` (prompt / schedule / requires
 * / apps) and `handler.js` during the build conversation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  APP_AUTOMATIONS_SUBDIR,
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  isValidAppId,
  isValidAutomationId,
  validateManifest,
  type AutomationManifest,
  type AutomationTrigger,
  type AutomationHistoryKeep,
} from '@centraid/runtime-core';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

/** The name prefix that marks an app folder as an automation app. */
export const AUTOMATION_APP_PREFIX = 'auto.';

export interface AutomationScaffoldOptions {
  /** Display name. Defaults to the app id. */
  name?: string;
  description?: string;
  /** The human intent the builder agent translates into `handler.js`. */
  prompt?: string;
  /**
   * 5-field cron expression for a single cron trigger. Ignored when
   * `triggers` is set. Defaults to a daily 9am schedule.
   */
  cronExpr?: string;
  /**
   * Explicit trigger list — overrides `cronExpr`. An empty array is a
   * legal "manual fire only" automation. Webhook triggers must already
   * carry their generated `id` + `secretHash`, or be the pending form.
   */
  triggers?: readonly AutomationTrigger[];
  /** App ids this automation is associated with. */
  apps?: readonly string[];
  /** Model `ctx.agent` calls route through (`provider/model-id`). */
  model?: string;
  /** Run-retention policy. Defaults to keeping the last 100 runs. */
  historyKeep?: AutomationHistoryKeep;
  /** Automation to fire when this one fails — a `<appId>/<id>` handle. */
  onFailure?: string;
  /**
   * Initial `enabled` flag. Defaults to `true`. The conversational
   * builder scaffolds a *draft* (`false`) so the cron does not start
   * firing before the user reviews the automation and enables it.
   */
  enabled?: boolean;
  /**
   * Id of the single automation under `automations/`. Defaults to the
   * app id with the `auto.` prefix stripped (or `main` when that is not
   * a valid automation slug).
   */
  automationId?: string;
}

/** Validate an automation app folder id — an `auto.`-prefixed app id. */
export function validateAutomationAppId(appId: string): void {
  if (!appId.startsWith(AUTOMATION_APP_PREFIX) || !isValidAppId(appId)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid automation app id "${appId}". Expected an "${AUTOMATION_APP_PREFIX}"-prefixed app id.`,
    );
  }
}

/** Validate an automation id (the directory slug under `automations/`). */
export function validateAutomationId(id: string): void {
  if (id.startsWith('_') || !isValidAutomationId(id)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid automation id "${id}". Use A-Z / a-z / 0-9 / "-" / "_", no leading "_".`,
    );
  }
}

/** Derive the inner automation id from the app id. */
function defaultAutomationId(appId: string): string {
  const stripped = appId.slice(AUTOMATION_APP_PREFIX.length);
  return isValidAutomationId(stripped) ? stripped : 'main';
}

const DEFAULT_HANDLER = `/**
 * Automation handler — runs on the cron schedule in automation.json.
 *
 * Available on \`ctx\`:
 *   ctx.tool(name, args)   — call an MCP tool
 *   ctx.agent({ prompt })  — one constrained model turn
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *   ctx.runs.last/list     — this automation's prior runs
 *   ctx.invoke(ref, { input }) — fire another automation by its handle
 *
 * Return \`{ summary?, output? }\` — \`summary\` shows in the run list.
 */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  return { summary: 'ok' };
};
`;

function starterManifest(name: string, opts: AutomationScaffoldOptions): AutomationManifest {
  const triggers: readonly AutomationTrigger[] =
    opts.triggers !== undefined
      ? opts.triggers
      : [{ kind: 'cron', expr: opts.cronExpr?.trim() || '0 9 * * *' }];
  const requires: Record<string, unknown> = {};
  if (opts.model?.trim()) requires.model = opts.model.trim();
  const raw: Record<string, unknown> = {
    name,
    version: '0.1.0',
    enabled: opts.enabled ?? true,
    prompt: opts.prompt?.trim() || 'Describe what this automation should do.',
    triggers: [...triggers],
    requires,
    history: { keep: opts.historyKeep ?? { count: 100 } },
    generated: { by: 'centraid-builder', at: new Date().toISOString() },
  };
  if (opts.description?.trim()) raw.description = opts.description.trim();
  if (opts.apps && opts.apps.length > 0) raw.apps = [...opts.apps];
  if (opts.onFailure?.trim()) raw.onFailure = opts.onFailure.trim();
  // Round-trip through the validator so a scaffold can never write a
  // manifest the runtime would later reject.
  return validateManifest(raw);
}

/**
 * Scaffold a new automation app folder under `<appsDir>/<appId>/` — an
 * `app.json` plus a single automation under `automations/<autoId>/`.
 * Throws `HarnessError` on a bad id or an app folder that already exists.
 */
export async function scaffoldAutomationProject(
  appsDir: string,
  appId: string,
  opts: AutomationScaffoldOptions = {},
): Promise<ProjectInfo> {
  validateAutomationAppId(appId);
  const automationId = opts.automationId ?? defaultAutomationId(appId);
  validateAutomationId(automationId);

  const appDir = path.join(appsDir, appId);
  try {
    await fs.access(appDir);
    throw new HarnessError(
      'already_exists',
      `Automation app "${appId}" already exists at ${appDir}.`,
    );
  } catch (err) {
    if (err instanceof HarnessError) throw err;
    // ENOENT — the directory is free, proceed.
  }

  const name = opts.name?.trim() || appId;
  const autoDir = path.join(appDir, APP_AUTOMATIONS_SUBDIR, automationId);
  await fs.mkdir(autoDir, { recursive: true });

  const appJson: Record<string, unknown> = { name, version: '0.1.0' };
  if (opts.description?.trim()) appJson.description = opts.description.trim();
  await fs.writeFile(path.join(appDir, 'app.json'), JSON.stringify(appJson, null, 2) + '\n');

  const manifest = starterManifest(name, opts);
  await fs.writeFile(
    path.join(autoDir, AUTOMATION_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  await fs.writeFile(path.join(autoDir, AUTOMATION_HANDLER_FILE), DEFAULT_HANDLER);

  const stat = await fs.stat(appDir);
  return {
    id: appId,
    dir: appDir,
    built: true,
    modifiedAt: stat.mtime.toISOString(),
    name,
    ...(typeof appJson.description === 'string' ? { description: appJson.description } : {}),
  };
}
