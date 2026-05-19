/**
 * Automation manifest schema + validator.
 *
 * Each automation in an app lives as three artifacts:
 *
 *   1. `automations/<name>.json` — manifest (this module's shape)
 *   2. `actions/<name>.js`       — generated JS handler
 *   3. cron expression           — embedded in the manifest's `trigger.expr`
 *
 * Trigger shape is `trigger: { kind: 'cron', expr }` — the shape leaves
 * room for webhook/event kinds without a second migration. Only `cron`
 * is wired today.
 *
 * Output-schema validation + `validateOutputAgainstSchema` live in
 * `automation-manifest-output.ts` to keep this file focused. Error class
 * + validation-code union live in `automation-manifest-errors.ts`.
 */

import { AutomationManifestError } from './automation-manifest-errors.js';
import { validateOutputSchema, type AutomationOutputSchema } from './automation-manifest-output.js';

export {
  AutomationManifestError,
  type AutomationManifestValidationCode,
} from './automation-manifest-errors.js';
export {
  validateOutputAgainstSchema,
  type AutomationOutputSchema,
} from './automation-manifest-output.js';

export interface AutomationManifestRequires {
  /** MCP server ids the handler requires (`["github", "linear"]`). */
  readonly mcps?: readonly string[];
  /** Fully-qualified tool names the handler calls (`["github.list_pull_requests"]`). */
  readonly tools?: readonly string[];
  /**
   * Model the `ctx.agent` calls should route through. Format: `provider/model-id`
   * (`"anthropic/claude-3-5-sonnet"`, `"openai/gpt-4o"`). Must not target the
   * mock provider (`centraid-mock/*`) — that would recurse into the mock
   * StreamFn. Validation rejects it.
   */
  readonly model?: string;
}

export interface AutomationCostEstimate {
  readonly model: string;
  readonly tokensPerFire: number;
}

export interface AutomationGeneratedMeta {
  readonly by: string;
  readonly at: string;
}

/**
 * Trigger surface. Only `cron` is wired today; webhook / event kinds are
 * future work (issue #80 § Out). The shape leaves room without forcing
 * a second migration.
 */
export type AutomationTrigger = { readonly kind: 'cron'; readonly expr: string };

/**
 * Retention policy applied at end-of-run to `runs` (and via CASCADE,
 * `run_nodes`). One of: `{count: N}` keep newest N, `{days: N}` drop
 * older than N days, `"all"` keep everything (no-op), `"errors"` keep
 * only failed runs. Default at validation time is `{count: 100}`.
 */
export type AutomationHistoryKeep =
  | { readonly count: number }
  | { readonly days: number }
  | 'all'
  | 'errors';

export interface AutomationHistoryConfig {
  readonly keep: AutomationHistoryKeep;
}

export interface AutomationManifest {
  readonly prompt: string;
  readonly trigger: AutomationTrigger;
  readonly action: string;
  readonly requires: AutomationManifestRequires;
  readonly costEstimate?: AutomationCostEstimate;
  readonly outputSchema?: AutomationOutputSchema;
  readonly onFailure?: string;
  readonly history: AutomationHistoryConfig;
  readonly generated: AutomationGeneratedMeta;
}

export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^[0-9*,\-/?A-Za-z]+$/;
  return fields.every((f) => fieldPattern.test(f));
}

export function isValidActionFilename(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (!name.endsWith('.js')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  const base = name.slice(0, -3);
  if (!base) return false;
  return /^[A-Za-z0-9_-]+$/.test(base);
}

export function isValidAutomationName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AutomationManifestError(
      'missing_field',
      `manifest.${field} must be a non-empty string`,
      field,
    );
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AutomationManifestError(
      'invalid_field',
      `manifest.${field} must be an array of strings`,
      field,
    );
  }
  return value.map((entry, idx) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new AutomationManifestError(
        'invalid_field',
        `manifest.${field}[${idx}] must be a non-empty string`,
        `${field}[${idx}]`,
      );
    }
    return entry;
  });
}

function resolveTrigger(r: Record<string, unknown>): AutomationTrigger {
  const triggerRaw = r.trigger;
  if (triggerRaw === undefined) {
    throw new AutomationManifestError(
      'missing_field',
      'manifest.trigger must be { kind: "cron", expr: "<cron>" }',
      'trigger',
    );
  }
  if (triggerRaw === null || typeof triggerRaw !== 'object' || Array.isArray(triggerRaw)) {
    throw new AutomationManifestError(
      'invalid_trigger',
      'manifest.trigger must be an object with { kind, expr }',
      'trigger',
    );
  }
  const t = triggerRaw as Record<string, unknown>;
  if (t.kind !== 'cron') {
    throw new AutomationManifestError(
      'invalid_trigger',
      `manifest.trigger.kind "${String(t.kind)}" is not supported — only "cron" is wired today`,
      'trigger.kind',
    );
  }
  const expr = requireString(t.expr, 'trigger.expr');
  if (!isValidCronExpression(expr)) {
    throw new AutomationManifestError(
      'invalid_trigger',
      `manifest.trigger.expr "${expr}" is not a valid 5-field cron expression`,
      'trigger.expr',
    );
  }
  return { kind: 'cron', expr };
}

const DEFAULT_HISTORY_KEEP_COUNT = 100;

function validateHistory(raw: unknown): AutomationHistoryConfig {
  if (raw === undefined) return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AutomationManifestError(
      'invalid_history',
      'manifest.history must be an object',
      'history',
    );
  }
  const h = raw as Record<string, unknown>;
  if (h.keep === undefined) return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  const keep = h.keep;
  if (keep === 'all' || keep === 'errors') return { keep };
  if (keep === null || typeof keep !== 'object' || Array.isArray(keep)) {
    throw new AutomationManifestError(
      'invalid_history',
      'manifest.history.keep must be {count:N} | {days:N} | "all" | "errors"',
      'history.keep',
    );
  }
  const k = keep as Record<string, unknown>;
  if (typeof k.count === 'number' && Number.isInteger(k.count) && k.count >= 0) {
    return { keep: { count: k.count } };
  }
  if (typeof k.days === 'number' && Number.isInteger(k.days) && k.days >= 0) {
    return { keep: { days: k.days } };
  }
  throw new AutomationManifestError(
    'invalid_history',
    'manifest.history.keep must be {count:N} | {days:N} | "all" | "errors"',
    'history.keep',
  );
}

function validateRequires(raw: unknown): AutomationManifestRequires {
  if (raw !== undefined && (raw === null || typeof raw !== 'object')) {
    throw new AutomationManifestError(
      'invalid_field',
      'manifest.requires must be an object',
      'requires',
    );
  }
  const req = (raw ?? {}) as Record<string, unknown>;
  const mcps = optionalStringArray(req.mcps, 'requires.mcps');
  const tools = optionalStringArray(req.tools, 'requires.tools');
  let model: string | undefined;
  if (req.model !== undefined) {
    if (typeof req.model !== 'string' || req.model.length === 0) {
      throw new AutomationManifestError(
        'invalid_field',
        'manifest.requires.model must be a non-empty string',
        'requires.model',
      );
    }
    if (req.model.startsWith('centraid-mock/') || req.model === 'centraid-mock') {
      throw new AutomationManifestError(
        'mock_model_disallowed',
        `manifest.requires.model "${req.model}" points at the centraid-mock provider — that would recurse into the automation runtime itself`,
        'requires.model',
      );
    }
    model = req.model;
  }
  const requires: AutomationManifestRequires = {};
  if (mcps) (requires as { mcps: readonly string[] }).mcps = mcps;
  if (tools) (requires as { tools: readonly string[] }).tools = tools;
  if (model !== undefined) (requires as { model: string }).model = model;
  return requires;
}

function validateCostEstimate(raw: unknown): AutomationCostEstimate | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') {
    throw new AutomationManifestError(
      'invalid_field',
      'manifest.costEstimate must be an object',
      'costEstimate',
    );
  }
  const ce = raw as Record<string, unknown>;
  const model = requireString(ce.model, 'costEstimate.model');
  if (
    typeof ce.tokensPerFire !== 'number' ||
    !Number.isFinite(ce.tokensPerFire) ||
    ce.tokensPerFire < 0
  ) {
    throw new AutomationManifestError(
      'invalid_field',
      'manifest.costEstimate.tokensPerFire must be a non-negative finite number',
      'costEstimate.tokensPerFire',
    );
  }
  return { model, tokensPerFire: ce.tokensPerFire };
}

function validateOnFailure(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AutomationManifestError(
      'invalid_on_failure',
      'manifest.onFailure must be a non-empty string naming another automation',
      'onFailure',
    );
  }
  if (!isValidAutomationName(raw)) {
    throw new AutomationManifestError(
      'invalid_on_failure',
      `manifest.onFailure "${raw}" is not a valid automation name`,
      'onFailure',
    );
  }
  return raw;
}

export function parseManifest(json: string): AutomationManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new AutomationManifestError(
      'invalid_json',
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): AutomationManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AutomationManifestError('invalid_field', 'manifest must be a JSON object');
  }
  const r = raw as Record<string, unknown>;

  const prompt = requireString(r.prompt, 'prompt');
  const trigger = resolveTrigger(r);
  const action = requireString(r.action, 'action');
  if (!isValidActionFilename(action)) {
    throw new AutomationManifestError(
      'invalid_action_path',
      `manifest.action "${action}" must be a bare filename ending in .js (no slashes, no '..')`,
      'action',
    );
  }
  const requires = validateRequires(r.requires);
  const costEstimate = validateCostEstimate(r.costEstimate);
  const outputSchema = validateOutputSchema(r.outputSchema);
  const onFailure = validateOnFailure(r.onFailure);
  const history = validateHistory(r.history);

  const genRaw = r.generated;
  if (!genRaw || typeof genRaw !== 'object' || Array.isArray(genRaw)) {
    throw new AutomationManifestError(
      'missing_field',
      'manifest.generated must be an object',
      'generated',
    );
  }
  const gen = genRaw as Record<string, unknown>;
  const generated: AutomationGeneratedMeta = {
    by: requireString(gen.by, 'generated.by'),
    at: requireString(gen.at, 'generated.at'),
  };

  return {
    prompt,
    trigger,
    action,
    requires,
    ...(costEstimate ? { costEstimate } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(onFailure ? { onFailure } : {}),
    history,
    generated,
  };
}
