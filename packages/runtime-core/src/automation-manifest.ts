/**
 * Automation manifest schema + validator.
 *
 * Each automation in an app lives as three artifacts (see issue #70):
 *
 *   1. `automations/<name>.json` — manifest (this module's shape)
 *   2. `actions/<name>.js`       — generated JS handler
 *   3. cron expression           — embedded in the manifest's `schedule`
 *
 * The manifest is the canonical source of truth — re-prompting overwrites
 * the .js, and the prompt is preserved verbatim in `prompt`. Validation
 * here is shared between the producer (builder-harness) and consumers
 * (runtime-core automation runner, openclaw plugin reconciliation pass,
 * desktop UI display).
 */

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
  /** Model identifier the estimate is for. */
  readonly model: string;
  /** Estimated tokens consumed by a single fire. */
  readonly tokensPerFire: number;
}

export interface AutomationGeneratedMeta {
  /** What produced this manifest (`"builder"`, `"hand"`, `"test"` …). */
  readonly by: string;
  /** ISO-8601 timestamp of generation. */
  readonly at: string;
}

export interface AutomationManifest {
  /** The user's natural-language prompt — never paraphrased, never lost. */
  readonly prompt: string;
  /** Five-field cron expression (UTC) — e.g. every-30-min: `[asterisk]/30 * * * *`. */
  readonly schedule: string;
  /** Filename of the generated JS handler under `actions/`. */
  readonly action: string;
  /** Capability dependencies surfaced at install-time host-runtime check. */
  readonly requires: AutomationManifestRequires;
  /** Optional cost telemetry surfaced in UI. */
  readonly costEstimate?: AutomationCostEstimate;
  /** Provenance — when, by what, against what model. */
  readonly generated: AutomationGeneratedMeta;
}

export type AutomationManifestValidationCode =
  | 'invalid_json'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_schedule'
  | 'invalid_action_path'
  | 'mock_model_disallowed';

export class AutomationManifestError extends Error {
  readonly code: AutomationManifestValidationCode;
  readonly field?: string;
  constructor(code: AutomationManifestValidationCode, message: string, field?: string) {
    super(message);
    this.name = 'AutomationManifestError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

/**
 * Minimal cron validator: five whitespace-separated fields with the
 * legal character classes for each field's value range. We deliberately
 * do not parse semantics (next-fire calculation lives in the host
 * scheduler — launchd, openclaw cron); this just rejects obvious
 * garbage at install time before the host scheduler rejects it less
 * helpfully.
 *
 * Allowed per field: digits, `*`, `,`, `-`, `/`, and (for day-of-week)
 * the three-letter weekday names. Day-of-month also allows `?` as some
 * cron flavors require it.
 */
export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^[0-9*,\-/?A-Za-z]+$/;
  return fields.every((f) => fieldPattern.test(f));
}

/** Action filename must be a bare basename ending in `.js` — no slashes, no `..`. */
export function isValidActionFilename(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (!name.endsWith('.js')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  // Basename without extension must be a sensible identifier.
  const base = name.slice(0, -3);
  if (!base) return false;
  return /^[A-Za-z0-9_-]+$/.test(base);
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

/**
 * Parse + validate a manifest from its on-disk JSON form. Returns the
 * frozen manifest on success, throws `AutomationManifestError` on failure.
 * Callers that have the parsed object already can call `validateManifest`
 * directly.
 */
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
  const schedule = requireString(r.schedule, 'schedule');
  if (!isValidCronExpression(schedule)) {
    throw new AutomationManifestError(
      'invalid_schedule',
      `manifest.schedule "${schedule}" is not a valid 5-field cron expression`,
      'schedule',
    );
  }
  const action = requireString(r.action, 'action');
  if (!isValidActionFilename(action)) {
    throw new AutomationManifestError(
      'invalid_action_path',
      `manifest.action "${action}" must be a bare filename ending in .js (no slashes, no '..')`,
      'action',
    );
  }

  const requiresRaw = r.requires;
  if (requiresRaw !== undefined && (requiresRaw === null || typeof requiresRaw !== 'object')) {
    throw new AutomationManifestError(
      'invalid_field',
      'manifest.requires must be an object',
      'requires',
    );
  }
  const req = (requiresRaw ?? {}) as Record<string, unknown>;
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
      // Hard rule: routing ctx.agent through our own mock provider would
      // recurse into the StreamFn that is currently executing the handler.
      // See "Manifest validation — recursion guard" in issue #70.
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

  let costEstimate: AutomationCostEstimate | undefined;
  const ceRaw = r.costEstimate;
  if (ceRaw !== undefined) {
    if (ceRaw === null || typeof ceRaw !== 'object') {
      throw new AutomationManifestError(
        'invalid_field',
        'manifest.costEstimate must be an object',
        'costEstimate',
      );
    }
    const ce = ceRaw as Record<string, unknown>;
    const ceModel = requireString(ce.model, 'costEstimate.model');
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
    costEstimate = { model: ceModel, tokensPerFire: ce.tokensPerFire };
  }

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

  const manifest: AutomationManifest = {
    prompt,
    schedule,
    action,
    requires,
    ...(costEstimate ? { costEstimate } : {}),
    generated,
  };
  return manifest;
}

/**
 * Automation name = manifest filename without extension. Mirrors the
 * convention queries and actions follow (`<name>.js`); we expose this so
 * scaffolding + UI use one source of truth.
 *
 * Allowed: same identifier subset as `isValidActionFilename`.
 */
export function isValidAutomationName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/.test(name);
}
