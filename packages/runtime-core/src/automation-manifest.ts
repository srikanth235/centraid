/**
 * Automation manifest schema + validator.
 *
 * Issue #91: an automation is a first-class *project* — its own
 * directory under `automationsDir`, structurally a sibling of an app.
 * `automation.json` is the project manifest (this module's shape); the
 * generated handler is a single `handler.js` in the same directory.
 *
 * The manifest is the source of truth — there is no SQLite definition
 * table. `enabled` lives here (toggling it rewrites the file), so a
 * scheduler host can register/suppress from the manifest alone.
 *
 * Trigger shape is `triggers: AutomationTrigger[]` — a plural list of
 * `cron` and `webhook` entries. Legacy single-`trigger` manifests are
 * dual-read by `resolveTriggers` and rewritten plural on next save, so
 * no filesystem migration is needed.
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

/** Conventional handler filename inside an automation project directory. */
export const AUTOMATION_HANDLER_FILE = 'handler.js';
/** Conventional manifest filename inside an automation project directory. */
export const AUTOMATION_MANIFEST_FILE = 'automation.json';

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
 * Trigger surface. A `cron` trigger fires on a 5-field schedule; a
 * `webhook` trigger fires on an inbound HTTP POST to a gateway route
 * (remote-gateway only — the desktop preserves the entry but never
 * registers it). An automation may carry many cron triggers but at
 * most one webhook.
 */
export type CronTrigger = { readonly kind: 'cron'; readonly expr: string };
export type WebhookTrigger = {
  readonly kind: 'webhook';
  /** Generated route slug — the path segment under `/_centraid-hook/`. */
  readonly id: string;
  /**
   * SHA-256 hex of the shared secret. The plaintext secret is generated
   * server-side and shown once at creation; only this hash is persisted
   * because `automation.json` is user-visible.
   */
  readonly secretHash: string;
};
/**
 * A webhook trigger the builder agent declared but cannot provision —
 * minting the route `id` + `secret` is a privileged server step. The
 * desktop's `provisionPendingWebhookAt` pass rewrites it to a
 * `WebhookTrigger`; this is the agent→builder handoff form.
 */
export type PendingWebhookTrigger = {
  readonly kind: 'webhook';
  readonly pending: true;
};
export type AutomationTrigger = CronTrigger | WebhookTrigger | PendingWebhookTrigger;

/** The cron triggers from a trigger list, in declaration order. */
export function cronTriggersOf(triggers: readonly AutomationTrigger[]): readonly CronTrigger[] {
  return triggers.filter((t): t is CronTrigger => t.kind === 'cron');
}

/** True for a webhook trigger still awaiting server-side provisioning. */
export function isPendingWebhookTrigger(t: AutomationTrigger): t is PendingWebhookTrigger {
  return t.kind === 'webhook' && 'pending' in t;
}

/**
 * The single *provisioned* webhook trigger from a trigger list, if any.
 * A pending (un-minted) webhook trigger is skipped — it has no `id` to
 * route on yet.
 */
export function webhookTriggerOf(
  triggers: readonly AutomationTrigger[],
): WebhookTrigger | undefined {
  return triggers.find((t): t is WebhookTrigger => t.kind === 'webhook' && 'id' in t);
}

/** The single pending (un-provisioned) webhook trigger, if any. */
export function pendingWebhookTriggerOf(
  triggers: readonly AutomationTrigger[],
): PendingWebhookTrigger | undefined {
  return triggers.find(isPendingWebhookTrigger);
}

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

/**
 * The `automation.json` project manifest.
 *
 * `name` / `version` / `description` mirror `app.json`. `enabled` is the
 * user's on/off toggle — it lives in the manifest because the directory
 * is the only source of truth. `prompt` is the human intent the builder
 * agent translated into `handler.js`; `apps` lists the app ids this
 * automation is associated with (reverse-looked-up by the app Settings
 * screen).
 */
export interface AutomationManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly prompt: string;
  /**
   * Trigger list. Empty is legal — an automation with no triggers fires
   * only via an explicit "Run now". At most one entry is a webhook.
   */
  readonly triggers: readonly AutomationTrigger[];
  readonly requires: AutomationManifestRequires;
  /** App ids this automation is associated with. */
  readonly apps?: readonly string[];
  readonly costEstimate?: AutomationCostEstimate;
  readonly outputSchema?: AutomationOutputSchema;
  /** Sibling automation id to fire when this one fails. */
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

/**
 * Validate an automation *id* (the directory slug). Same grammar an app
 * project id uses — lowercase-safe, filesystem-safe.
 */
export function isValidAutomationId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
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

/** Webhook route slugs use the same filesystem-safe grammar as ids. */
function isValidWebhookId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

function validateOneTrigger(raw: unknown, field: string): AutomationTrigger {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AutomationManifestError(
      'invalid_trigger',
      `manifest.${field} must be an object with a "kind"`,
      field,
    );
  }
  const t = raw as Record<string, unknown>;
  if (t.kind === 'cron') {
    const expr = requireString(t.expr, `${field}.expr`);
    if (!isValidCronExpression(expr)) {
      throw new AutomationManifestError(
        'invalid_trigger',
        `manifest.${field}.expr "${expr}" is not a valid 5-field cron expression`,
        `${field}.expr`,
      );
    }
    return { kind: 'cron', expr };
  }
  if (t.kind === 'webhook') {
    // A pending webhook (`{ kind: 'webhook', pending: true }`) the
    // builder agent declared but cannot provision — accepted here so
    // the manifest round-trips until the builder mints id + secret.
    if (t.id === undefined && t.secretHash === undefined) {
      if (t.pending !== true) {
        throw new AutomationManifestError(
          'invalid_trigger',
          `manifest.${field} webhook trigger needs a minted "id" + "secretHash", or "pending": true`,
          field,
        );
      }
      return { kind: 'webhook', pending: true };
    }
    const id = requireString(t.id, `${field}.id`);
    if (!isValidWebhookId(id)) {
      throw new AutomationManifestError(
        'invalid_trigger',
        `manifest.${field}.id "${id}" is not a valid webhook route slug`,
        `${field}.id`,
      );
    }
    const secretHash = requireString(t.secretHash, `${field}.secretHash`);
    return { kind: 'webhook', id, secretHash };
  }
  throw new AutomationManifestError(
    'invalid_trigger',
    `manifest.${field}.kind "${String(t.kind)}" is not supported — expected "cron" or "webhook"`,
    `${field}.kind`,
  );
}

/**
 * Dual-read trigger resolution. A plural `triggers` array is the
 * canonical shape; a legacy single `trigger` object is wrapped into a
 * one-element list (the manifest is rewritten plural on next save). A
 * manifest with neither is legal — an empty list means "manual fire
 * only". At most one webhook trigger is allowed.
 */
function resolveTriggers(r: Record<string, unknown>): readonly AutomationTrigger[] {
  let list: AutomationTrigger[];
  if (r.triggers !== undefined) {
    if (!Array.isArray(r.triggers)) {
      throw new AutomationManifestError(
        'invalid_trigger',
        'manifest.triggers must be an array',
        'triggers',
      );
    }
    list = r.triggers.map((t, i) => validateOneTrigger(t, `triggers[${i}]`));
  } else if (r.trigger !== undefined) {
    list = [validateOneTrigger(r.trigger, 'trigger')];
  } else {
    list = [];
  }
  if (list.filter((t) => t.kind === 'webhook').length > 1) {
    throw new AutomationManifestError(
      'invalid_trigger',
      'manifest.triggers may contain at most one webhook trigger',
      'triggers',
    );
  }
  return list;
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
  if (!isValidAutomationId(raw)) {
    throw new AutomationManifestError(
      'invalid_on_failure',
      `manifest.onFailure "${raw}" is not a valid automation id`,
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

  const name = requireString(r.name, 'name');
  const version = r.version === undefined ? '0.1.0' : requireString(r.version, 'version');
  let description: string | undefined;
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') {
      throw new AutomationManifestError(
        'invalid_field',
        'manifest.description must be a string',
        'description',
      );
    }
    description = r.description;
  }
  const enabled = r.enabled === undefined ? true : r.enabled === true;
  const prompt = requireString(r.prompt, 'prompt');
  const triggers = resolveTriggers(r);
  const requires = validateRequires(r.requires);
  const apps = optionalStringArray(r.apps, 'apps');
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
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    enabled,
    prompt,
    triggers,
    requires,
    ...(apps ? { apps } : {}),
    ...(costEstimate ? { costEstimate } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(onFailure ? { onFailure } : {}),
    history,
    generated,
  };
}
