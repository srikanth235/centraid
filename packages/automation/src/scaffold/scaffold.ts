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
import { APP_AUTOMATIONS_SUBDIR } from './app.js';
import { isValidId } from '../manifest/ref.js';
import {
  HANDLER_FILE,
  MANIFEST_FILE,
  validateManifest,
  type Manifest,
  type Trigger,
  type HistoryKeep,
  type ManifestVault,
} from '../manifest/manifest.js';
import { isValidAppId } from '@centraid/app-engine';
import { AppScaffoldError, type ScaffoldFile, type AppInfo } from '@centraid/blueprints';

export interface ScaffoldOptions {
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
  triggers?: readonly Trigger[];
  /** App ids this automation is associated with. */
  apps?: readonly string[];
  /** Model `ctx.agent` calls route through (`provider/model-id`). */
  model?: string;
  /** Run-retention policy. Defaults to keeping the last 100 runs. */
  historyKeep?: HistoryKeep;
  /** Automation to fire when this one fails — a `<appId>/<id>` handle. */
  onFailure?: string;
  /**
   * Requested vault access a `condition`/`data` trigger's consented read
   * runs under (duaility §12). `validateManifest` requires this block
   * whenever `triggers` carries a condition/data entry — omitting it while
   * declaring one of those triggers fails validation loudly rather than
   * scaffolding an automation that can never evaluate its own trigger.
   */
  vault?: ManifestVault;
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
export function validateAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new AppScaffoldError(
      'invalid_id',
      `Invalid automation app id "${appId}". Use a filesystem-safe slug (letters / digits / "-" / "_").`,
    );
  }
}

/** Validate an automation id (the directory slug under `automations/`). */
export function validateId(id: string): void {
  if (id.startsWith('_') || !isValidId(id)) {
    throw new AppScaffoldError(
      'invalid_id',
      `Invalid automation id "${id}". Use A-Z / a-z / 0-9 / "-" / "_", no leading "_".`,
    );
  }
}

/** Derive the inner automation id from the app id. */
function defaultAutomationId(appId: string): string {
  return isValidId(appId) ? appId : 'main';
}

const DEFAULT_HANDLER = `/**
 * Automation handler — runs on the schedule/trigger in automation.json.
 *
 * DETERMINISM & THE AUDITED ctx.* RAILS (read before editing)
 * All side effects and I/O MUST go through ctx.* — those calls are recorded in
 * the run ledger, so a raw fetch()/fs call is invisible to the run history.
 * Keep the handler deterministic too: a crashed fire re-runs from the top
 * (there is no resume journal), so nondeterminism makes the re-run diverge and
 * re-fire effects. So:
 *   • No ambient nondeterminism: no Date.now(), no new Date(), no Math.random(),
 *     no randomUUID(), no reading env/clock/filesystem/network directly.
 *   • All side effects + I/O go through ctx.* — never a raw fetch()/fs call.
 *   • Pure JS between ctx.* calls (loops, conditionals, transforms) is free.
 *   • Need "now" or a watermark? Derive it from ctx.runs.last() / ctx.state, or
 *     read a timestamp off a ctx.vault result — not the wall clock.
 *
 * DETERMINISTIC WORK vs JUDGEMENT
 *   • ctx.vault · ctx.fetch · ctx.state · ctx.runs — deterministic, in-process
 *     work. Zero model tokens, zero processes spawned. Prefer these for
 *     anything code or a vault read/write can do.
 *   • ctx.agent({ prompt }) — the ONLY billed path: one bounded model turn
 *     through the configured agent CLI (over ACP). Use it only for genuine
 *     inference (summarize / classify / extract / draft). Declare the model
 *     tier in automation.json#requires.model.
 *
 * \`ctx\` surface: ctx.vault · ctx.fetch · ctx.agent · ctx.state.get/set/delete
 * · ctx.runs.last/list · ctx.input. Return \`{ summary?, output? }\` —
 * \`summary\` shows in the run list.
 *
 * @type {import('@centraid/automation').AutomationHandler}
 */
export default async ({ ctx, log }) => {
  log.info('automation fired');

  // Watermark from the prior successful run — the deterministic stand-in for
  // "since last time" (never Date.now()).
  const last = await ctx.runs.last({ status: 'ok' });
  const since = last?.startedAt ?? 0;

  // DETERMINISTIC rail (zero tokens, zero processes): read what you need from
  // the vault. Replace this placeholder query with the real one for your task.
  const recent = await ctx.vault.search({ entity: 'core.thread', text: '', limit: 20 });
  const rows = Array.isArray(recent?.rows) ? recent.rows : [];

  // Pure JS between ctx.* calls — filter/shape the data yourself.
  const fresh = rows.filter((r) => (r.updated_at ?? 0) > since);
  if (fresh.length === 0) return { summary: 'nothing new' };

  // BILLED rail: one constrained model turn for the part that needs judgement.
  // Pass \`json\` so the result is parsed and a model failure is detected.
  const result = await ctx.agent({
    prompt: \`Summarize these in one line:\\n\${JSON.stringify(fresh)}\`,
    json: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  });

  return { summary: result.summary, output: { count: fresh.length } };
};
`;

function starterManifest(name: string, opts: ScaffoldOptions): Manifest {
  const triggers: readonly Trigger[] =
    opts.triggers !== undefined
      ? opts.triggers
      : [{ kind: 'cron', expr: opts.cronExpr?.trim() || '0 9 * * *' }];
  // Emit the `requires` slots the builder may fill (issue #167): `model` is the
  // ctx.agent capability tier (`provider/model-id`) — picked for the cheapest
  // tier that does the inference (e.g. a small/cheap tier for summarization).
  // It is left out until chosen so it is never a misleading default; a handler
  // that never calls ctx.agent needs no `requires` at all.
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
    generated: { by: 'centraid-compiler', at: new Date().toISOString() },
  };
  if (opts.description?.trim()) raw.description = opts.description.trim();
  if (opts.apps && opts.apps.length > 0) raw.apps = [...opts.apps];
  if (opts.onFailure?.trim()) raw.onFailure = opts.onFailure.trim();
  if (opts.vault) raw.vault = opts.vault;
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
export function scaffoldAppFiles(appId: string, opts: ScaffoldOptions = {}): ScaffoldFile[] {
  validateAppId(appId);
  const automationId = opts.automationId ?? defaultAutomationId(appId);
  validateId(automationId);

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
      path: `${base}/${MANIFEST_FILE}`,
      content: JSON.stringify(manifest, null, 2) + '\n',
    },
    { path: `${base}/${HANDLER_FILE}`, content: DEFAULT_HANDLER },
  ];
}

/**
 * Flip an automation's `enabled` toggle within a draft file map (issue
 * #141). Returns the changed files (the one `automation.json`), or `[]`
 * when the automation is absent or already at the requested state.
 * Round-trips through `validateManifest` so we never write a manifest the
 * runtime would reject.
 */
export function setEnabledInFiles(
  current: ScaffoldFile[],
  automationId: string,
  enabled: boolean,
): ScaffoldFile[] {
  const target = `${APP_AUTOMATIONS_SUBDIR}/${automationId}/${MANIFEST_FILE}`;
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
export function deleteFromFiles(
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
 * Thin filesystem wrapper over {@link scaffoldAppFiles}.
 * Throws `AppScaffoldError` on a bad id or an app folder that already exists.
 */
export async function scaffoldApp(
  appsDir: string,
  appId: string,
  opts: ScaffoldOptions = {},
): Promise<AppInfo> {
  const files = scaffoldAppFiles(appId, opts);
  const appDir = path.join(appsDir, appId);
  try {
    await fs.access(appDir);
    throw new AppScaffoldError(
      'already_exists',
      `Automation app "${appId}" already exists at ${appDir}.`,
    );
  } catch (err) {
    if (err instanceof AppScaffoldError) throw err;
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
