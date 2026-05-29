/**
 * Scaffold a new automation app (issue #98 unified folder model).
 *
 * An automation is never standalone — it is one app folder under
 * `appsDir`, an *automation app*: a folder whose `app.json` declares
 * `kind: 'automation'` and which holds exactly one automation under
 * `automations/<id>/`. It carries no UI assets. This module writes the
 * minimal layout the builder agent then fills in:
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
import type { ScaffoldFile } from './scaffold-files.js';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

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
   * app id itself (or `main` when the app id is not a valid automation
   * slug).
   */
  automationId?: string;
}

/**
 * Validate an automation app folder id. Automation apps are marked by the
 * manifest's `kind: 'automation'` field (not a dotted `auto.` prefix), so
 * this is just the plain app-id slug check.
 */
export function validateAutomationAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid automation app id "${appId}". Use a filesystem-safe slug (letters / digits / "-" / "_").`,
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
  return isValidAutomationId(appId) ? appId : 'main';
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
 * Filesystem-free variant (issue #141): build the file map for a new
 * automation app — `app.json` plus a single automation under
 * `automations/<autoId>/` (manifest + handler). The caller PUTs these
 * into a git-store session and publishes.
 */
export function scaffoldAutomationProjectFiles(
  appId: string,
  opts: AutomationScaffoldOptions = {},
): ScaffoldFile[] {
  validateAutomationAppId(appId);
  const automationId = opts.automationId ?? defaultAutomationId(appId);
  validateAutomationId(automationId);

  const name = opts.name?.trim() || appId;
  // Manifest must satisfy the post-#107 schema (manifestVersion + id +
  // actions[] + queries[]). An automation app has no user-facing
  // actions/queries — the automation lives under `automations/<id>/`.
  const appJson: Record<string, unknown> = {
    manifestVersion: 1,
    id: appId,
    name,
    // Marks this as a UI-less automation app (replaces the legacy `auto.`
    // id prefix) — the desktop surfaces it on the Automations page.
    kind: 'automation',
    version: '0.1.0',
    actions: [],
    queries: [],
  };
  if (opts.description?.trim()) appJson.description = opts.description.trim();
  const manifest = starterManifest(name, opts);
  const base = `${APP_AUTOMATIONS_SUBDIR}/${automationId}`;
  return [
    { path: 'app.json', content: JSON.stringify(appJson, null, 2) + '\n' },
    {
      path: `${base}/${AUTOMATION_MANIFEST_FILE}`,
      content: JSON.stringify(manifest, null, 2) + '\n',
    },
    { path: `${base}/${AUTOMATION_HANDLER_FILE}`, content: DEFAULT_HANDLER },
  ];
}

/**
 * Flip an automation's `enabled` toggle within a draft file map (issue
 * #141). Returns the changed files (the one `automation.json`), or `[]`
 * when the automation is absent or already at the requested state.
 * Round-trips through `validateManifest` so we never write a manifest the
 * runtime would reject.
 */
export function setAutomationEnabledInFiles(
  current: ScaffoldFile[],
  automationId: string,
  enabled: boolean,
): ScaffoldFile[] {
  const target = `${APP_AUTOMATIONS_SUBDIR}/${automationId}/${AUTOMATION_MANIFEST_FILE}`;
  const file = current.find((f) => f.path === target);
  if (!file) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (parsed.enabled === enabled) return [];
  const manifest = validateManifest({ ...parsed, enabled });
  return [{ path: target, content: JSON.stringify(manifest, null, 2) + '\n' }];
}

/**
 * Remove one automation from a draft file map (issue #141). Returns the
 * surviving files plus the removed paths (everything under
 * `automations/<automationId>/`) so the caller can DELETE them in the
 * git-store session.
 */
export function deleteAutomationFromFiles(
  current: ScaffoldFile[],
  automationId: string,
): { keep: ScaffoldFile[]; removed: string[] } {
  const prefix = `${APP_AUTOMATIONS_SUBDIR}/${automationId}/`;
  const keep: ScaffoldFile[] = [];
  const removed: string[] = [];
  for (const f of current) {
    if (f.path.startsWith(prefix)) removed.push(f.path);
    else keep.push(f);
  }
  return { keep, removed };
}

/**
 * Scaffold a new automation app folder under `<appsDir>/<appId>/` — an
 * `app.json` plus a single automation under `automations/<autoId>/`.
 * Thin filesystem wrapper over {@link scaffoldAutomationProjectFiles}.
 * Throws `HarnessError` on a bad id or an app folder that already exists.
 */
export async function scaffoldAutomationProject(
  appsDir: string,
  appId: string,
  opts: AutomationScaffoldOptions = {},
): Promise<ProjectInfo> {
  const files = scaffoldAutomationProjectFiles(appId, opts);
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

  for (const file of files) {
    const dest = path.join(appDir, file.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content);
  }

  const appJson = JSON.parse(files.find((f) => f.path === 'app.json')!.content) as {
    name?: string;
    description?: string;
  };
  const stat = await fs.stat(appDir);
  return {
    id: appId,
    dir: appDir,
    built: true,
    modifiedAt: stat.mtime.toISOString(),
    name: appJson.name,
    kind: 'automation',
    ...(typeof appJson.description === 'string' ? { description: appJson.description } : {}),
  };
}
