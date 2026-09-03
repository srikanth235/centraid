import { promises as fs } from "node:fs";
import path from "node:path";

import { AppScaffoldError } from "@centraid/blueprints";
import type { ScaffoldFile, AppInfo } from "@centraid/blueprints";
import { isValidAppId } from "@centraid/server/engine";

import {
  HANDLER_FILE,
  MANIFEST_FILE,
  validateManifest,
} from "../manifest/manifest.js";
import type {
  Manifest,
  Trigger,
  HistoryKeep,
  ConnectionBinding,
  ConnectorSpec,
  ManifestVault,
} from "../manifest/manifest.js";
import { isValidId } from "../manifest/ref.js";
import { APP_AUTOMATIONS_SUBDIR } from "./app.js";

export interface ScaffoldOptions {
  name?: string;
  description?: string;
  prompt?: string;
  cronExpr?: string;
  triggers?: readonly Trigger[];
  apps?: readonly string[];
  harness?: string;
  model?: string;
  historyKeep?: HistoryKeep;
  onFailure?: string;
  vault?: ManifestVault;
  connector?: ConnectorSpec;
  connections?: readonly ConnectionBinding[];
  enabled?: boolean;
  automationId?: string;
}

export function validateAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new AppScaffoldError(
      "invalid_id",
      `Invalid automation app id "${appId}". Use a filesystem-safe slug (letters / digits / "-" / "_").`
    );
  }
}

export function validateId(id: string): void {
  if (id.startsWith("_") || !isValidId(id)) {
    throw new AppScaffoldError(
      "invalid_id",
      `Invalid automation id "${id}". Use A-Z / a-z / 0-9 / "-" / "_", no leading "_".`
    );
  }
}

function defaultAutomationId(appId: string): string {
  return isValidId(appId) ? appId : "main";
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
 *   • ctx.delegate({ prompt }) — the ONLY billed path: one bounded model turn
 *     through the configured harness (over ACP). Use it only for genuine
 *     inference (summarize / classify / extract / draft). Declare the model
 *     tier in automation.json#requires.model.
 *
 * \`ctx\` surface: ctx.vault · ctx.fetch · ctx.delegate · ctx.state.get/set/delete
 * · ctx.runs.last/list · ctx.input. Return \`{ summary?, output? }\` —
 * \`summary\` shows in the run list.
 *
 * @type {import('@centraid/server/automation').AutomationHandler}
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
  const result = await ctx.delegate({
    prompt: \`Summarize these in one line:\\n\${JSON.stringify(fresh)}\`,
    json: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  });

  return { summary: result.summary, output: { count: fresh.length } };
};
`;

function starterManifest(name: string, opts: ScaffoldOptions): Manifest {
  const triggers: readonly Trigger[] =
    opts.triggers === undefined
      ? [{ kind: "cron", expr: opts.cronExpr?.trim() || "0 9 * * *" }]
      : opts.triggers;
  const requires: Record<string, unknown> = {};
  if (opts.harness?.trim()) requires.harness = opts.harness.trim();
  if (opts.model?.trim()) requires.model = opts.model.trim();
  const raw: Record<string, unknown> = {
    name,
    version: "0.1.0",
    enabled: opts.enabled ?? true,
    prompt: opts.prompt?.trim() || "Describe what this automation should do.",
    triggers: [...triggers],
    requires,
    history: { keep: opts.historyKeep ?? { count: 100 } },
    generated: { by: "centraid-compiler", at: new Date().toISOString() },
  };
  if (opts.description?.trim()) raw.description = opts.description.trim();
  if (opts.apps && opts.apps.length > 0) raw.apps = [...opts.apps];
  if (opts.onFailure?.trim()) raw.onFailure = opts.onFailure.trim();
  if (opts.vault) raw.vault = opts.vault;
  if (opts.connector) raw.connector = opts.connector;
  if (opts.connections && opts.connections.length > 0)
    raw.connections = [...opts.connections];
  return validateManifest(raw);
}

export function scaffoldAppFiles(
  appId: string,
  opts: ScaffoldOptions = {}
): ScaffoldFile[] {
  validateAppId(appId);
  const automationId = opts.automationId ?? defaultAutomationId(appId);
  validateId(automationId);

  const name = opts.name?.trim() || appId;
  const appJson: Record<string, unknown> = {
    manifestVersion: 1,
    id: appId,
    name,
    kind: "automation",
    version: "0.1.0",
    actions: [],
    queries: [],
  };
  if (opts.description?.trim()) appJson.description = opts.description.trim();
  const manifest = starterManifest(name, opts);
  const base = `${APP_AUTOMATIONS_SUBDIR}/${automationId}`;
  return [
    { path: "app.json", content: JSON.stringify(appJson, null, 2) + "\n" },
    {
      path: `${base}/${MANIFEST_FILE}`,
      content: JSON.stringify(manifest, null, 2) + "\n",
    },
    { path: `${base}/${HANDLER_FILE}`, content: DEFAULT_HANDLER },
  ];
}

export function setEnabledInFiles(
  current: ScaffoldFile[],
  automationId: string,
  enabled: boolean
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
  return [{ path: target, content: JSON.stringify(manifest, null, 2) + "\n" }];
}

export function deleteFromFiles(
  current: ScaffoldFile[],
  automationId: string
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

export async function scaffoldApp(
  appsDir: string,
  appId: string,
  opts: ScaffoldOptions = {}
): Promise<AppInfo> {
  const files = scaffoldAppFiles(appId, opts);
  const appDir = path.join(appsDir, appId);
  try {
    await fs.access(appDir);
    throw new AppScaffoldError(
      "already_exists",
      `Automation app "${appId}" already exists at ${appDir}.`
    );
  } catch (error) {
    if (error instanceof AppScaffoldError) throw error;
  }

  await Promise.all(
    files.map(async (file) => {
      const dest = path.join(appDir, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content);
    })
  );

  const appJson = JSON.parse(
    files.find((f) => f.path === "app.json")!.content
  ) as {
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
    kind: "automation",
    ...(typeof appJson.description === "string"
      ? { description: appJson.description }
      : {}),
  };
}
