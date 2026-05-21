/**
 * Scaffold a new automation *project* (issue #91).
 *
 * An automation is a first-class project — its own directory under
 * `automationsDir`, structurally a sibling of an app project. This
 * module writes the minimal layout the builder agent then fills in:
 *
 *   <automationsDir>/<id>/automation.json   — the manifest
 *   <automationsDir>/<id>/handler.js        — the generated handler
 *   <automationsDir>/<id>/versions/         — published snapshots
 *
 * The builder agent rewrites `automation.json` (prompt / schedule /
 * requires / apps) and `handler.js` during the build conversation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  isValidAutomationId,
  validateManifest,
  type AutomationManifest,
} from '@centraid/runtime-core';
import type { ProjectInfo } from './types.js';
import { HarnessError } from './types.js';

export interface AutomationScaffoldOptions {
  /** Display name. Defaults to the id. */
  name?: string;
  description?: string;
  /** The human intent the builder agent translates into `handler.js`. */
  prompt?: string;
  /** 5-field cron expression. Defaults to a daily 9am schedule. */
  cronExpr?: string;
  /** App ids this automation is associated with. */
  apps?: readonly string[];
}

/** Validate an automation project id (the directory slug). */
export function validateAutomationId(id: string): void {
  if (id.startsWith('_') || !isValidAutomationId(id)) {
    throw new HarnessError(
      'invalid_id',
      `Invalid automation id "${id}". Use A-Z / a-z / 0-9 / "-" / "_", no leading "_".`,
    );
  }
}

const DEFAULT_HANDLER = `/**
 * Automation handler — runs on the cron schedule in automation.json.
 *
 * Available on \`ctx\`:
 *   ctx.tool(name, args)   — call an MCP tool
 *   ctx.agent({ prompt })  — one constrained model turn
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *   ctx.runs.last/list     — this automation's prior runs
 *   ctx.invoke(id, { input }) — fire a sibling automation
 *
 * Return \`{ summary?, output? }\` — \`summary\` shows in the run list.
 */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  return { summary: 'ok' };
};
`;

function starterManifest(id: string, opts: AutomationScaffoldOptions): AutomationManifest {
  const raw: Record<string, unknown> = {
    name: opts.name?.trim() || id,
    version: '0.1.0',
    enabled: true,
    prompt: opts.prompt?.trim() || 'Describe what this automation should do.',
    trigger: { kind: 'cron', expr: opts.cronExpr?.trim() || '0 9 * * *' },
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'centraid-builder', at: new Date().toISOString() },
  };
  if (opts.description?.trim()) raw.description = opts.description.trim();
  if (opts.apps && opts.apps.length > 0) raw.apps = [...opts.apps];
  // Round-trip through the validator so a scaffold can never write a
  // manifest the runtime would later reject.
  return validateManifest(raw);
}

/**
 * Scaffold a new automation project folder under
 * `<automationsDir>/<id>/`. Throws `HarnessError` on a bad id or a
 * directory that already exists.
 */
export async function scaffoldAutomationProject(
  automationsDir: string,
  id: string,
  opts: AutomationScaffoldOptions = {},
): Promise<ProjectInfo> {
  validateAutomationId(id);
  const dir = path.join(automationsDir, id);
  try {
    await fs.access(dir);
    throw new HarnessError('already_exists', `Automation "${id}" already exists at ${dir}.`);
  } catch (err) {
    if (err instanceof HarnessError) throw err;
    // ENOENT — the directory is free, proceed.
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'versions'));

  const manifest = starterManifest(id, opts);
  await fs.writeFile(
    path.join(dir, AUTOMATION_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  await fs.writeFile(path.join(dir, AUTOMATION_HANDLER_FILE), DEFAULT_HANDLER);

  const stat = await fs.stat(dir);
  return {
    id,
    dir,
    built: true,
    modifiedAt: stat.mtime.toISOString(),
    name: manifest.name,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
  };
}
