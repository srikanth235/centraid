/**
 * Automation manifest schema + validator.
 *
 * Issue #98 (unified folder model): an automation is a first-class
 * *unit* that always lives inside an app folder, at
 * `<appCodeDir>/automations/<id>/`. `automation.json` is the automation
 * manifest (this module's shape); the generated handler is a single
 * `handler.js` in the same directory.
 *
 * The manifest is the source of truth — there is no SQLite definition
 * table. `enabled` lives here (toggling it rewrites the file), so a
 * scheduler host can register/suppress from the manifest alone.
 *
 * Trigger shape is `triggers: Trigger[]` — a plural list of `cron`,
 * `webhook`, `condition` and `data` entries.
 *
 * Output-schema validation + `validateOutputAgainstSchema` live in
 * `manifest-output.ts` to keep this file focused. Error class
 * + validation-code union live in `manifest-errors.ts`.
 */

import { ManifestError } from './manifest-errors.js';
import { validateOutputSchema, type OutputSchema } from './manifest-output.js';
import { isValidRef } from './ref.js';

export { ManifestError, type ManifestValidationCode } from './manifest-errors.js';
export { validateOutputAgainstSchema, type OutputSchema } from './manifest-output.js';

/** Conventional handler filename inside an automation app directory. */
export const HANDLER_FILE = 'handler.js';
/** Conventional manifest filename inside an automation app directory. */
export const MANIFEST_FILE = 'automation.json';

export interface ManifestRequires {
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

export interface CostEstimate {
  readonly model: string;
  readonly tokensPerFire: number;
}

/**
 * One requested vault scope — the same grammar an app's `app.json` vault
 * block uses. `schema` alone covers the whole domain; `table` narrows to a
 * single entity or command name.
 */
export interface ManifestVaultScope {
  readonly schema: string;
  readonly table?: string;
  readonly verbs: 'read' | 'read+act' | 'act';
}

/**
 * The automation's requested vault access (duaility §12). Fires authenticate
 * as an enrolled `agent.agent`; this block is a *request* the owner approves
 * into a grant on the agent's party — never a grant by itself. Until
 * approval every `ctx.vault` call is a receipted deny.
 */
export interface ManifestVault {
  /** DPV purpose notation, e.g. `dpv:ServiceProvision`. */
  readonly purpose: string;
  /** Owner-facing one-liner: why this automation needs the access. */
  readonly why?: string;
  readonly scopes: readonly ManifestVaultScope[];
}

export interface GeneratedMeta {
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

/** Filter ops a condition trigger may use — the vault's FilterClause grammar. */
export const CONDITION_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'is-null',
  'not-null',
  'within-days',
  'within-next-days',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ConditionWhereClause {
  readonly column: string;
  readonly op: ConditionOp;
  readonly value?: unknown;
}

/** Cron gate a condition trigger evaluates on when `every` is omitted. */
export const CONDITION_DEFAULT_EVERY = '*/5 * * * *';

/**
 * A data-derived time trigger: on the `every` gate the host runs the
 * declared consented read under the automation's agent grant and fires once
 * per row it has not seen before (row-content dedup — a row that changes
 * fires again; one that merely stays matched does not). This is how "invoice
 * due in 3 days" or "warranty ends next week" become fires without wall-clock
 * cron guesswork: the time semantics live in the data, the trigger just
 * watches the window. Requires a manifest `vault` block — the read runs
 * under that grant, and a receipted deny disables the evaluation, never
 * widens it.
 */
export type ConditionTrigger = {
  readonly kind: 'condition';
  /** Logical vault entity, e.g. `business.invoice`. */
  readonly entity: string;
  /** Filter ANDed into the consented read. */
  readonly where?: readonly ConditionWhereClause[];
  /** 5-field cron gate for evaluation. Default: every 5 minutes. */
  readonly every?: string;
};

/** Cron gate a data trigger polls the change feed on when `every` is omitted. */
export const DATA_DEFAULT_EVERY = '* * * * *';

/**
 * A data-change trigger: the host pulls the vault's consented provenance
 * feed (`ctx.vault.changes`) for the watched entities on the `every` gate
 * and fires with the new change entries as input. The cursor is a strictly
 * time-ordered journal id persisted across evaluations, bootstrapped at the
 * current watermark — a fresh watcher reacts to what happens next, never to
 * history. This is how "a credit posted → reconcile the invoice" and
 * "my parked send was confirmed → resume" become fires. Requires a manifest
 * `vault` block whose grant covers reading every watched entity.
 */
export type DataTrigger = {
  readonly kind: 'data';
  /** Logical vault entities to watch, e.g. `['core.transaction']`. */
  readonly entities: readonly string[];
  /** 5-field cron gate for polling. Default: every minute. */
  readonly every?: string;
};

export type Trigger =
  | CronTrigger
  | WebhookTrigger
  | PendingWebhookTrigger
  | ConditionTrigger
  | DataTrigger;

/** The cron triggers from a trigger list, in declaration order. */
export function cronTriggersOf(triggers: readonly Trigger[]): readonly CronTrigger[] {
  return triggers.filter((t): t is CronTrigger => t.kind === 'cron');
}

/** True for a webhook trigger still awaiting server-side provisioning. */
export function isPendingWebhookTrigger(t: Trigger): t is PendingWebhookTrigger {
  return t.kind === 'webhook' && 'pending' in t;
}

/**
 * The single *provisioned* webhook trigger from a trigger list, if any.
 * A pending (un-minted) webhook trigger is skipped — it has no `id` to
 * route on yet.
 */
export function webhookTriggerOf(triggers: readonly Trigger[]): WebhookTrigger | undefined {
  return triggers.find((t): t is WebhookTrigger => t.kind === 'webhook' && 'id' in t);
}

/** The single pending (un-provisioned) webhook trigger, if any. */
export function pendingWebhookTriggerOf(
  triggers: readonly Trigger[],
): PendingWebhookTrigger | undefined {
  return triggers.find(isPendingWebhookTrigger);
}

/**
 * The host-evaluated "watch" triggers (condition + data) with their gate
 * cadence and their positions in the ORIGINAL trigger list — the index is
 * a trigger's stable identity for evaluation cursors, so it must survive
 * cron/webhook entries sitting between them.
 */
export function watchTriggersOf(
  triggers: readonly Trigger[],
): readonly { trigger: ConditionTrigger | DataTrigger; expr: string; index: number }[] {
  const watches: { trigger: ConditionTrigger | DataTrigger; expr: string; index: number }[] = [];
  triggers.forEach((t, index) => {
    if (t.kind === 'condition') {
      watches.push({ trigger: t, expr: t.every ?? CONDITION_DEFAULT_EVERY, index });
    } else if (t.kind === 'data') {
      watches.push({ trigger: t, expr: t.every ?? DATA_DEFAULT_EVERY, index });
    }
  });
  return watches;
}

/**
 * Retention policy applied at end-of-run to `runs` (and via CASCADE,
 * `run_nodes`). One of: `{count: N}` keep newest N, `{days: N}` drop
 * older than N days, `"all"` keep everything (no-op), `"errors"` keep
 * only failed runs. Default at validation time is `{count: 100}`.
 */
export type HistoryKeep = { readonly count: number } | { readonly days: number } | 'all' | 'errors';

export interface HistoryConfig {
  readonly keep: HistoryKeep;
}

/**
 * The `automation.json` app manifest.
 *
 * `name` / `version` / `description` mirror `app.json`. `enabled` is the
 * user's on/off toggle — it lives in the manifest because the directory
 * is the only source of truth. `prompt` is the human intent the builder
 * agent translated into `handler.js`; `apps` lists the app ids this
 * automation is associated with (reverse-looked-up by the app Settings
 * screen).
 */
export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly prompt: string;
  /**
   * Trigger list. Empty is legal — an automation with no triggers fires
   * only via an explicit "Run now". At most one entry is a webhook.
   */
  readonly triggers: readonly Trigger[];
  readonly requires: ManifestRequires;
  /** Requested vault access — owner-approved into a grant on the automation's agent. */
  readonly vault?: ManifestVault;
  /** App ids this automation is associated with. */
  readonly apps?: readonly string[];
  readonly costEstimate?: CostEstimate;
  readonly outputSchema?: OutputSchema;
  /**
   * Automation to fire when this one fails — a `<appId>/<id>` handle, or
   * a bare `<id>` for a sibling within the same app.
   */
  readonly onFailure?: string;
  readonly history: HistoryConfig;
  readonly generated: GeneratedMeta;
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError('missing_field', `manifest.${field} must be a non-empty string`, field);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ManifestError(
      'invalid_field',
      `manifest.${field} must be an array of strings`,
      field,
    );
  }
  return value.map((entry, idx) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ManifestError(
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

function validateOneTrigger(raw: unknown, field: string): Trigger {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(
      'invalid_trigger',
      `manifest.${field} must be an object with a "kind"`,
      field,
    );
  }
  const t = raw as Record<string, unknown>;
  if (t.kind === 'cron') {
    const expr = requireString(t.expr, `${field}.expr`);
    if (!isValidCronExpression(expr)) {
      throw new ManifestError(
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
        throw new ManifestError(
          'invalid_trigger',
          `manifest.${field} webhook trigger needs a minted "id" + "secretHash", or "pending": true`,
          field,
        );
      }
      return { kind: 'webhook', pending: true };
    }
    const id = requireString(t.id, `${field}.id`);
    if (!isValidWebhookId(id)) {
      throw new ManifestError(
        'invalid_trigger',
        `manifest.${field}.id "${id}" is not a valid webhook route slug`,
        `${field}.id`,
      );
    }
    const secretHash = requireString(t.secretHash, `${field}.secretHash`);
    return { kind: 'webhook', id, secretHash };
  }
  if (t.kind === 'condition') {
    const entity = requireString(t.entity, `${field}.entity`);
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(entity)) {
      throw new ManifestError(
        'invalid_trigger',
        `manifest.${field}.entity "${entity}" is not a <schema>.<table> entity name`,
        `${field}.entity`,
      );
    }
    let every: string | undefined;
    if (t.every !== undefined) {
      every = requireString(t.every, `${field}.every`);
      if (!isValidCronExpression(every)) {
        throw new ManifestError(
          'invalid_trigger',
          `manifest.${field}.every "${every}" is not a valid 5-field cron expression`,
          `${field}.every`,
        );
      }
    }
    let where: ConditionWhereClause[] | undefined;
    if (t.where !== undefined) {
      if (!Array.isArray(t.where)) {
        throw new ManifestError(
          'invalid_trigger',
          `manifest.${field}.where must be an array of {column, op, value?} clauses`,
          `${field}.where`,
        );
      }
      where = t.where.map((raw, i) => {
        const cf = `${field}.where[${i}]`;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new ManifestError('invalid_trigger', `manifest.${cf} must be an object`, cf);
        }
        const c = raw as Record<string, unknown>;
        const column = requireString(c.column, `${cf}.column`);
        if (typeof c.op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(c.op)) {
          throw new ManifestError(
            'invalid_trigger',
            `manifest.${cf}.op must be one of ${CONDITION_OPS.join(', ')}`,
            `${cf}.op`,
          );
        }
        return {
          column,
          op: c.op as ConditionOp,
          ...(c.value !== undefined ? { value: c.value } : {}),
        } satisfies ConditionWhereClause;
      });
    }
    return {
      kind: 'condition',
      entity,
      ...(where ? { where } : {}),
      ...(every !== undefined ? { every } : {}),
    };
  }
  if (t.kind === 'data') {
    if (!Array.isArray(t.entities) || t.entities.length === 0) {
      throw new ManifestError(
        'invalid_trigger',
        `manifest.${field}.entities must be a non-empty array of <schema>.<table> names`,
        `${field}.entities`,
      );
    }
    const entities = t.entities.map((raw, i) => {
      const ef = `${field}.entities[${i}]`;
      const entity = requireString(raw, ef);
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(entity)) {
        throw new ManifestError(
          'invalid_trigger',
          `manifest.${ef} "${entity}" is not a <schema>.<table> entity name`,
          ef,
        );
      }
      return entity;
    });
    let every: string | undefined;
    if (t.every !== undefined) {
      every = requireString(t.every, `${field}.every`);
      if (!isValidCronExpression(every)) {
        throw new ManifestError(
          'invalid_trigger',
          `manifest.${field}.every "${every}" is not a valid 5-field cron expression`,
          `${field}.every`,
        );
      }
    }
    return { kind: 'data', entities, ...(every !== undefined ? { every } : {}) };
  }
  throw new ManifestError(
    'invalid_trigger',
    `manifest.${field}.kind "${String(t.kind)}" is not supported — expected "cron", "webhook", "condition" or "data"`,
    `${field}.kind`,
  );
}

/**
 * Trigger resolution. `triggers` is a plural array; a manifest without one
 * is legal — an empty list means "manual fire only". At most one webhook
 * trigger is allowed.
 */
function resolveTriggers(r: Record<string, unknown>): readonly Trigger[] {
  let list: Trigger[];
  if (r.triggers !== undefined) {
    if (!Array.isArray(r.triggers)) {
      throw new ManifestError('invalid_trigger', 'manifest.triggers must be an array', 'triggers');
    }
    list = r.triggers.map((t, i) => validateOneTrigger(t, `triggers[${i}]`));
  } else {
    list = [];
  }
  if (list.filter((t) => t.kind === 'webhook').length > 1) {
    throw new ManifestError(
      'invalid_trigger',
      'manifest.triggers may contain at most one webhook trigger',
      'triggers',
    );
  }
  return list;
}

const DEFAULT_HISTORY_KEEP_COUNT = 100;

function validateHistory(raw: unknown): HistoryConfig {
  if (raw === undefined) return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('invalid_history', 'manifest.history must be an object', 'history');
  }
  const h = raw as Record<string, unknown>;
  if (h.keep === undefined) return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  const keep = h.keep;
  if (keep === 'all' || keep === 'errors') return { keep };
  if (keep === null || typeof keep !== 'object' || Array.isArray(keep)) {
    throw new ManifestError(
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
  throw new ManifestError(
    'invalid_history',
    'manifest.history.keep must be {count:N} | {days:N} | "all" | "errors"',
    'history.keep',
  );
}

function validateRequires(raw: unknown): ManifestRequires {
  if (raw !== undefined && (raw === null || typeof raw !== 'object')) {
    throw new ManifestError('invalid_field', 'manifest.requires must be an object', 'requires');
  }
  const req = (raw ?? {}) as Record<string, unknown>;
  const mcps = optionalStringArray(req.mcps, 'requires.mcps');
  const tools = optionalStringArray(req.tools, 'requires.tools');
  let model: string | undefined;
  if (req.model !== undefined) {
    if (typeof req.model !== 'string' || req.model.length === 0) {
      throw new ManifestError(
        'invalid_field',
        'manifest.requires.model must be a non-empty string',
        'requires.model',
      );
    }
    if (req.model.startsWith('centraid-mock/') || req.model === 'centraid-mock') {
      throw new ManifestError(
        'mock_model_disallowed',
        `manifest.requires.model "${req.model}" points at the centraid-mock provider — that would recurse into the automation runtime itself`,
        'requires.model',
      );
    }
    model = req.model;
  }
  const requires: ManifestRequires = {};
  if (mcps) (requires as { mcps: readonly string[] }).mcps = mcps;
  if (tools) (requires as { tools: readonly string[] }).tools = tools;
  if (model !== undefined) (requires as { model: string }).model = model;
  return requires;
}

const VAULT_VERBS = new Set(['read', 'read+act', 'act']);

function validateVault(raw: unknown): ManifestVault | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('invalid_field', 'manifest.vault must be an object', 'vault');
  }
  const v = raw as Record<string, unknown>;
  const purpose = requireString(v.purpose, 'vault.purpose');
  let why: string | undefined;
  if (v.why !== undefined) {
    if (typeof v.why !== 'string') {
      throw new ManifestError('invalid_field', 'manifest.vault.why must be a string', 'vault.why');
    }
    why = v.why;
  }
  if (!Array.isArray(v.scopes) || v.scopes.length === 0) {
    throw new ManifestError(
      'invalid_field',
      'manifest.vault.scopes must be a non-empty array',
      'vault.scopes',
    );
  }
  const scopes = v.scopes.map((raw, i) => {
    const field = `vault.scopes[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ManifestError('invalid_field', `manifest.${field} must be an object`, field);
    }
    const s = raw as Record<string, unknown>;
    const schema = requireString(s.schema, `${field}.schema`);
    if (typeof s.verbs !== 'string' || !VAULT_VERBS.has(s.verbs)) {
      throw new ManifestError(
        'invalid_field',
        `manifest.${field}.verbs must be "read" | "read+act" | "act"`,
        `${field}.verbs`,
      );
    }
    let table: string | undefined;
    if (s.table !== undefined) table = requireString(s.table, `${field}.table`);
    return {
      schema,
      ...(table !== undefined ? { table } : {}),
      verbs: s.verbs as ManifestVaultScope['verbs'],
    } satisfies ManifestVaultScope;
  });
  return { purpose, ...(why !== undefined ? { why } : {}), scopes };
}

function validateCostEstimate(raw: unknown): CostEstimate | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') {
    throw new ManifestError(
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
    throw new ManifestError(
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
    throw new ManifestError(
      'invalid_on_failure',
      'manifest.onFailure must be a non-empty string naming another automation',
      'onFailure',
    );
  }
  if (!isValidRef(raw)) {
    throw new ManifestError(
      'invalid_on_failure',
      `manifest.onFailure "${raw}" is not a valid automation handle`,
      'onFailure',
    );
  }
  return raw;
}

export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ManifestError(
      'invalid_json',
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): Manifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('invalid_field', 'manifest must be a JSON object');
  }
  const r = raw as Record<string, unknown>;

  const name = requireString(r.name, 'name');
  const version = r.version === undefined ? '0.1.0' : requireString(r.version, 'version');
  let description: string | undefined;
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') {
      throw new ManifestError(
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
  const vault = validateVault(r.vault);
  // A condition/data trigger IS a consented vault read — without a vault
  // block there is no grant to evaluate it under, so the manifest is
  // incoherent.
  if (!vault && triggers.some((t) => t.kind === 'condition' || t.kind === 'data')) {
    throw new ManifestError(
      'invalid_trigger',
      'manifest.triggers contains a condition/data trigger but no manifest.vault block declares the access it reads under',
      'vault',
    );
  }
  const apps = optionalStringArray(r.apps, 'apps');
  const costEstimate = validateCostEstimate(r.costEstimate);
  const outputSchema = validateOutputSchema(r.outputSchema);
  const onFailure = validateOnFailure(r.onFailure);
  const history = validateHistory(r.history);

  const genRaw = r.generated;
  if (!genRaw || typeof genRaw !== 'object' || Array.isArray(genRaw)) {
    throw new ManifestError('missing_field', 'manifest.generated must be an object', 'generated');
  }
  const gen = genRaw as Record<string, unknown>;
  const generated: GeneratedMeta = {
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
    ...(vault ? { vault } : {}),
    ...(apps ? { apps } : {}),
    ...(costEstimate ? { costEstimate } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(onFailure ? { onFailure } : {}),
    history,
    generated,
  };
}
