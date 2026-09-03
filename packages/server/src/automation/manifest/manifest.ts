// governance: allow-repo-hygiene file-size-limit manifest schema + validator are one closed vocabulary — the trigger/step/analytics shapes validate each other, so splitting scatters the invariants

import { isValidIanaTimeZone } from "../cron-timezone.js";
import { ENRICH_DOMAINS, ENRICH_LANES } from "../fire/enrich-gate.js";
import type { EnrichDomain, EnrichLane } from "../fire/enrich-gate.js";
import { ManifestError } from "./manifest-errors.js";
import { validateOutputSchema } from "./manifest-output.js";
import type { OutputSchema } from "./manifest-output.js";
import { isValidRef } from "./ref.js";

export { isValidIanaTimeZone } from "../cron-timezone.js";

export {
  ManifestError,
  type ManifestValidationCode,
} from "./manifest-errors.js";
export { type OutputSchema } from "./manifest-output.js";

export const HANDLER_FILE = "handler.js";
export const MANIFEST_FILE = "automation.json";

export interface ManifestRequires {
  readonly mcps?: readonly string[];
  readonly harness?: string;
  readonly model?: string;
  readonly thoughtLevel?: string;
  readonly secrets?: readonly string[];
}

export interface ManifestSandbox {
  readonly lane: "model-runtime" | "media-transcode";
}

export interface ManifestEnrich {
  readonly domain: EnrichDomain;
  readonly capability: string;
  readonly lane: EnrichLane;
  readonly delegateStep?: {
    readonly selected: "deterministic" | "delegate";
    readonly promptRev: string;
    readonly latency: string;
    readonly consequence: string;
  };
}

export interface CostEstimate {
  readonly model: string;
  readonly tokensPerFire: number;
}

export interface ManifestVaultFilterClause {
  readonly column: string;
  readonly op:
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "in"
    | "is-null"
    | "not-null"
    | "within-days"
    | "within-next-days";
  readonly value?: unknown;
}

export interface ManifestVaultScope {
  readonly schema: string;
  readonly table?: string;
  readonly verbs: "read" | "read+act" | "act" | "reveal";
  readonly rowFilter?: readonly ManifestVaultFilterClause[];
  readonly fieldMask?: readonly string[];
}

export interface ManifestVault {
  readonly purpose: string;
  readonly why?: string;
  readonly scopes: readonly ManifestVaultScope[];
}

export interface GeneratedMeta {
  readonly by: string;
  readonly at: string;
}

export type CronTrigger = {
  readonly kind: "cron";
  readonly expr: string;
  readonly tz?: string;
};
export type WebhookTrigger = {
  readonly kind: "webhook";
  readonly id: string;
  readonly secretHash: string;
};
export type PendingWebhookTrigger = {
  readonly kind: "webhook";
  readonly pending: true;
};

export const CONDITION_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is-null",
  "not-null",
  "within-days",
  "within-next-days",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ConditionWhereClause {
  readonly column: string;
  readonly op: ConditionOp;
  readonly value?: unknown;
}

export const CONDITION_DEFAULT_EVERY = "*/5 * * * *";

export type ConditionTrigger = {
  readonly kind: "condition";
  readonly entity: string;
  readonly where?: readonly ConditionWhereClause[];
  readonly every?: string;
};

export const DATA_DEFAULT_EVERY = "* * * * *";

export type DataTrigger = {
  readonly kind: "data";
  readonly entities: readonly string[];
  readonly every?: string;
};

export const EVENT_DEFAULT_EVERY = "*/5 * * * *";
export const EVENT_TRIGGER_CATALOG = {
  "pull.gmail": ["new-message"],
  "pull.github": ["pull-request", "issue"],
} as const;

export type EventTrigger = {
  readonly kind: "event";
  readonly connectorKind: string;
  readonly event: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly every?: string;
};

export type Trigger =
  | CronTrigger
  | WebhookTrigger
  | PendingWebhookTrigger
  | ConditionTrigger
  | DataTrigger
  | EventTrigger;

export type AutomationTriggerKind = Trigger["kind"];

export const AUTOMATION_TRIGGER_REGISTRY = {
  cron: {
    sideEffect: "schedule",
    consent: "manifest-grant",
    ledger: true,
    parse: parseCronTrigger,
  },
  webhook: {
    sideEffect: "external-input",
    consent: "route-secret",
    ledger: true,
    parse: parseWebhookTrigger,
  },
  condition: {
    sideEffect: "vault-read",
    consent: "manifest-grant",
    ledger: true,
    parse: parseConditionTrigger,
  },
  data: {
    sideEffect: "vault-read",
    consent: "manifest-grant",
    ledger: true,
    parse: parseDataTrigger,
  },
  event: {
    sideEffect: "provider-read",
    consent: "connection-binding",
    ledger: true,
    parse: parseEventTrigger,
  },
} as const satisfies Record<
  AutomationTriggerKind,
  {
    readonly sideEffect: string;
    readonly consent: string;
    readonly ledger: true;
    readonly parse: (value: Record<string, unknown>, field: string) => Trigger;
  }
>;

export const AUTOMATION_TRIGGER_KINDS = Object.freeze(
  Object.keys(AUTOMATION_TRIGGER_REGISTRY) as AutomationTriggerKind[]
);

const TRIGGER_CURSOR_DENIED_TABLES = new Set([
  "trigger_ingress",
  "automation_trigger_cursor",
  "automation_state",
  "scheduler_ledger",
  "conversations",
  "turns",
  "items",
  "attachments",
  "run_summary",
  "conversation_archive",
  "conversation_digest",
]);

export function isDeniedTriggerCursorEntity(entity: string): boolean {
  const [schema = "", table] = entity.split(".", 2);
  if (schema === "outbox") return true;
  return table === undefined && TRIGGER_CURSOR_DENIED_TABLES.has(schema);
}

function rejectDeniedTriggerEntity(entity: string, field: string): void {
  if (!isDeniedTriggerCursorEntity(entity)) return;
  throw new ManifestError(
    "invalid_trigger",
    `manifest.${field} must not watch "${entity}" — cursor machinery, outbox, ingress, and conversation-ledger entities are excluded to prevent trigger loops`,
    field
  );
}

export function cronTriggersOf(
  triggers: readonly Trigger[]
): readonly CronTrigger[] {
  return triggers.filter((t): t is CronTrigger => t.kind === "cron");
}

export function isPendingWebhookTrigger(
  t: Trigger
): t is PendingWebhookTrigger {
  return t.kind === "webhook" && "pending" in t;
}

export function webhookTriggerOf(
  triggers: readonly Trigger[]
): WebhookTrigger | undefined {
  return triggers.find(
    (t): t is WebhookTrigger => t.kind === "webhook" && "id" in t
  );
}

export function pendingWebhookTriggerOf(
  triggers: readonly Trigger[]
): PendingWebhookTrigger | undefined {
  return triggers.find(isPendingWebhookTrigger);
}

export type HistoryKeep =
  | { readonly count: number }
  | { readonly days: number }
  | "all"
  | "errors";

export interface HistoryConfig {
  readonly keep: HistoryKeep;
}

export interface ConnectorSpec {
  readonly kind: string;
  readonly label: string;
  readonly principal?: string;
  readonly connectionId?: string;
}

export interface ConnectionBinding {
  readonly connectionId: string;
  readonly kind: string;
  readonly label: string;
}

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly notify?: "always" | "failures" | "never";
  readonly prompt: string;
  readonly triggers: readonly Trigger[];
  readonly requires: ManifestRequires;
  readonly connector?: ConnectorSpec;
  readonly connections?: readonly ConnectionBinding[];
  readonly vault?: ManifestVault;
  readonly enrich?: ManifestEnrich;
  readonly sandbox?: ManifestSandbox;
  readonly apps?: readonly string[];
  readonly costEstimate?: CostEstimate;
  readonly outputSchema?: OutputSchema;
  readonly onFailure?: string;
  readonly history: HistoryConfig;
  readonly generated: GeneratedMeta;
}

export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== "string") return false;
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/u);
  if (fields.length !== 5) return false;
  const fieldPattern = /^[0-9*,\-/?A-Za-z]+$/u;
  return fields.every((f) => fieldPattern.test(f));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(
      "missing_field",
      `manifest.${field} must be a non-empty string`,
      field
    );
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ManifestError(
      "invalid_field",
      `manifest.${field} must be an array of strings`,
      field
    );
  }
  return value.map((entry, idx) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ManifestError(
        "invalid_field",
        `manifest.${field}[${idx}] must be a non-empty string`,
        `${field}[${idx}]`
      );
    }
    return entry;
  });
}

function isValidWebhookId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/u.test(id);
}

function parseCronTrigger(
  t: Record<string, unknown>,
  field: string
): CronTrigger {
  const expr = requireString(t.expr, `${field}.expr`);
  if (!isValidCronExpression(expr)) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field}.expr "${expr}" is not a valid 5-field cron expression`,
      `${field}.expr`
    );
  }
  let tz: string | undefined;
  if (t.tz !== undefined) {
    if (typeof t.tz !== "string" || !t.tz.trim()) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.tz must be a non-empty IANA timezone name when set`,
        `${field}.tz`
      );
    }
    tz = t.tz.trim();
    if (!isValidIanaTimeZone(tz)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.tz "${tz}" is not a known IANA timezone`,
        `${field}.tz`
      );
    }
  }
  return { kind: "cron", expr, ...(tz === undefined ? {} : { tz }) };
}

function parseWebhookTrigger(
  t: Record<string, unknown>,
  field: string
): WebhookTrigger | PendingWebhookTrigger {
  if (t.id === undefined && t.secretHash === undefined) {
    if (t.pending !== true) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field} webhook trigger needs a minted "id" + "secretHash", or "pending": true`,
        field
      );
    }
    return { kind: "webhook", pending: true };
  }
  const id = requireString(t.id, `${field}.id`);
  if (!isValidWebhookId(id)) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field}.id "${id}" is not a valid webhook route slug`,
      `${field}.id`
    );
  }
  const secretHash = requireString(t.secretHash, `${field}.secretHash`);
  return { kind: "webhook", id, secretHash };
}

function parseConditionTrigger(
  t: Record<string, unknown>,
  field: string
): ConditionTrigger {
  const entity = requireString(t.entity, `${field}.entity`);
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(entity)) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field}.entity "${entity}" is not a <schema>.<table> entity name`,
      `${field}.entity`
    );
  }
  rejectDeniedTriggerEntity(entity, `${field}.entity`);
  let every: string | undefined;
  if (t.every !== undefined) {
    every = requireString(t.every, `${field}.every`);
    if (!isValidCronExpression(every)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.every "${every}" is not a valid 5-field cron expression`,
        `${field}.every`
      );
    }
  }
  let where: ConditionWhereClause[] | undefined;
  if (t.where !== undefined) {
    if (!Array.isArray(t.where)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.where must be an array of {column, op, value?} clauses`,
        `${field}.where`
      );
    }
    where = t.where.map((rawLocal, i) => {
      const cf = `${field}.where[${i}]`;
      if (
        rawLocal === null ||
        typeof rawLocal !== "object" ||
        Array.isArray(rawLocal)
      ) {
        throw new ManifestError(
          "invalid_trigger",
          `manifest.${cf} must be an object`,
          cf
        );
      }
      const c = rawLocal as Record<string, unknown>;
      const column = requireString(c.column, `${cf}.column`);
      if (
        typeof c.op !== "string" ||
        !(CONDITION_OPS as readonly string[]).includes(c.op)
      ) {
        throw new ManifestError(
          "invalid_trigger",
          `manifest.${cf}.op must be one of ${CONDITION_OPS.join(", ")}`,
          `${cf}.op`
        );
      }
      return {
        column,
        op: c.op as ConditionOp,
        ...(c.value === undefined ? {} : { value: c.value }),
      } satisfies ConditionWhereClause;
    });
  }
  return {
    kind: "condition",
    entity,
    ...(where ? { where } : {}),
    ...(every === undefined ? {} : { every }),
  };
}

function parseDataTrigger(
  t: Record<string, unknown>,
  field: string
): DataTrigger {
  if (!Array.isArray(t.entities) || t.entities.length === 0) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field}.entities must be a non-empty array of <schema>.<table> names`,
      `${field}.entities`
    );
  }
  const entities = t.entities.map((rawLocal, i) => {
    const ef = `${field}.entities[${i}]`;
    const entity = requireString(rawLocal, ef);
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(entity)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${ef} "${entity}" is not a <schema>.<table> entity name`,
        ef
      );
    }
    rejectDeniedTriggerEntity(entity, ef);
    return entity;
  });
  let every: string | undefined;
  if (t.every !== undefined) {
    every = requireString(t.every, `${field}.every`);
    if (!isValidCronExpression(every)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.every "${every}" is not a valid 5-field cron expression`,
        `${field}.every`
      );
    }
  }
  return {
    kind: "data",
    entities,
    ...(every === undefined ? {} : { every }),
  };
}

function parseEventTrigger(
  t: Record<string, unknown>,
  field: string
): EventTrigger {
  const connectorKind = requireString(
    t.connectorKind,
    `${field}.connectorKind`
  );
  const event = requireString(t.event, `${field}.event`);
  const supported =
    EVENT_TRIGGER_CATALOG[connectorKind as keyof typeof EVENT_TRIGGER_CATALOG];
  if (!supported || !(supported as readonly string[]).includes(event)) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field} has unsupported provider event "${connectorKind}:${event}"`,
      `${field}.event`
    );
  }
  let every: string | undefined;
  if (t.every !== undefined) {
    every = requireString(t.every, `${field}.every`);
    if (!isValidCronExpression(every)) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.every "${every}" is not a valid 5-field cron expression`,
        `${field}.every`
      );
    }
  }
  let filter: Readonly<Record<string, unknown>> | undefined;
  if (t.filter !== undefined) {
    if (
      t.filter === null ||
      typeof t.filter !== "object" ||
      Array.isArray(t.filter)
    ) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest.${field}.filter must be an object`,
        `${field}.filter`
      );
    }
    filter = t.filter as Readonly<Record<string, unknown>>;
  }
  return {
    kind: "event",
    connectorKind,
    event,
    ...(filter ? { filter } : {}),
    ...(every ? { every } : {}),
  };
}

function validateOneTrigger(raw: unknown, field: string): Trigger {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_trigger",
      `manifest.${field} must be an object with a "kind"`,
      field
    );
  }
  const t = raw as Record<string, unknown>;
  const registration =
    typeof t.kind === "string"
      ? AUTOMATION_TRIGGER_REGISTRY[
          t.kind as keyof typeof AUTOMATION_TRIGGER_REGISTRY
        ]
      : undefined;
  if (registration) return registration.parse(t, field);
  throw new ManifestError(
    "invalid_trigger",
    `manifest.${field}.kind "${String(t.kind)}" is not supported — expected ${AUTOMATION_TRIGGER_KINDS.map((kind) => `"${kind}"`).join(", ")}`,
    `${field}.kind`
  );
}

function resolveTriggers(r: Record<string, unknown>): readonly Trigger[] {
  let list: Trigger[];
  if (r.triggers === undefined) {
    list = [];
  } else {
    if (!Array.isArray(r.triggers)) {
      throw new ManifestError(
        "invalid_trigger",
        "manifest.triggers must be an array",
        "triggers"
      );
    }
    list = r.triggers.map((t, i) => validateOneTrigger(t, `triggers[${i}]`));
  }
  if (list.filter((t) => t.kind === "webhook").length > 1) {
    throw new ManifestError(
      "invalid_trigger",
      "manifest.triggers may contain at most one webhook trigger",
      "triggers"
    );
  }
  return list;
}

const DEFAULT_HISTORY_KEEP_COUNT = 100;

const MAX_HISTORY_KEEP_COUNT = 10_000;
const MAX_HISTORY_KEEP_DAYS = 365;

const HISTORY_KEEP_SHAPES =
  'manifest.history.keep must be {count:N} | {days:N} | "errors"';

function validateHistory(raw: unknown): HistoryConfig {
  if (raw === undefined) return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_history",
      "manifest.history must be an object",
      "history"
    );
  }
  const h = raw as Record<string, unknown>;
  if (h.keep === undefined)
    return { keep: { count: DEFAULT_HISTORY_KEEP_COUNT } };
  const keep = h.keep;
  if (keep === "all") {
    throw new ManifestError(
      "invalid_history",
      'manifest.history.keep may not be "all": run history must stay bounded. ' +
        `Use {count:N} (max ${MAX_HISTORY_KEEP_COUNT}), {days:N} (max ` +
        `${MAX_HISTORY_KEEP_DAYS}), or "errors".`,
      "history.keep"
    );
  }
  if (keep === "errors") return { keep };
  if (keep === null || typeof keep !== "object" || Array.isArray(keep)) {
    throw new ManifestError(
      "invalid_history",
      HISTORY_KEEP_SHAPES,
      "history.keep"
    );
  }
  const k = keep as Record<string, unknown>;
  if (
    typeof k.count === "number" &&
    Number.isInteger(k.count) &&
    k.count >= 0
  ) {
    if (k.count > MAX_HISTORY_KEEP_COUNT) {
      throw new ManifestError(
        "invalid_history",
        `manifest.history.keep.count may not exceed ${MAX_HISTORY_KEEP_COUNT}`,
        "history.keep"
      );
    }
    return { keep: { count: k.count } };
  }
  if (typeof k.days === "number" && Number.isInteger(k.days) && k.days >= 0) {
    if (k.days > MAX_HISTORY_KEEP_DAYS) {
      throw new ManifestError(
        "invalid_history",
        `manifest.history.keep.days may not exceed ${MAX_HISTORY_KEEP_DAYS}`,
        "history.keep"
      );
    }
    return { keep: { days: k.days } };
  }
  throw new ManifestError(
    "invalid_history",
    HISTORY_KEEP_SHAPES,
    "history.keep"
  );
}

function validateRequires(raw: unknown): ManifestRequires {
  if (raw !== undefined && (raw === null || typeof raw !== "object")) {
    throw new ManifestError(
      "invalid_field",
      "manifest.requires must be an object",
      "requires"
    );
  }
  const req = (raw ?? {}) as Record<string, unknown>;
  const mcps = optionalStringArray(req.mcps, "requires.mcps");
  let harness: string | undefined;
  if (req.harness !== undefined) {
    if (typeof req.harness !== "string" || req.harness.length === 0) {
      throw new ManifestError(
        "invalid_field",
        "manifest.requires.harness must be a non-empty string",
        "requires.harness"
      );
    }
    harness = req.harness;
  }
  let model: string | undefined;
  if (req.model !== undefined) {
    if (typeof req.model !== "string" || req.model.length === 0) {
      throw new ManifestError(
        "invalid_field",
        "manifest.requires.model must be a non-empty string",
        "requires.model"
      );
    }
    if (
      req.model.startsWith("centraid-mock/") ||
      req.model === "centraid-mock"
    ) {
      throw new ManifestError(
        "mock_model_disallowed",
        `manifest.requires.model "${req.model}" points at the centraid-mock provider — that would recurse into the automation runtime itself`,
        "requires.model"
      );
    }
    model = req.model;
  }
  let thoughtLevel: string | undefined;
  if (req.thoughtLevel !== undefined) {
    if (typeof req.thoughtLevel !== "string" || req.thoughtLevel.length === 0) {
      throw new ManifestError(
        "invalid_field",
        "manifest.requires.thoughtLevel must be a non-empty string",
        "requires.thoughtLevel"
      );
    }
    thoughtLevel = req.thoughtLevel;
  }
  const secrets = optionalStringArray(req.secrets, "requires.secrets");
  if (secrets) {
    for (const ref of secrets) {
      if (!/^locker:(?:@[A-Za-z0-9._-]{1,64}|[^:@][^:]*):[a-z_]+$/u.test(ref)) {
        throw new ManifestError(
          "invalid_field",
          `manifest.requires.secrets entry "${ref}" must be "locker:<item_id>:<column>" or "locker:@<alias>:<column>" (issues #293, #298)`,
          "requires.secrets"
        );
      }
    }
  }
  const requires: ManifestRequires = {};
  if (mcps) (requires as { mcps: readonly string[] }).mcps = mcps;
  if (harness !== undefined)
    (requires as { harness: string }).harness = harness;
  if (model !== undefined) (requires as { model: string }).model = model;
  if (thoughtLevel !== undefined)
    (requires as { thoughtLevel: string }).thoughtLevel = thoughtLevel;
  if (secrets) (requires as { secrets: readonly string[] }).secrets = secrets;
  return requires;
}

function validateConnector(value: unknown): ConnectorSpec | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(
      "invalid_field",
      "manifest.connector must be an object",
      "connector"
    );
  }
  const c = value as Record<string, unknown>;
  const kind = requireString(c.kind, "connector.kind");
  const label = requireString(c.label, "connector.label");
  let principal: string | undefined;
  if (c.principal !== undefined) {
    principal = requireString(c.principal, "connector.principal");
  }
  let connectionId: string | undefined;
  if (c.connectionId !== undefined) {
    connectionId = requireString(c.connectionId, "connector.connectionId");
  }
  return {
    kind,
    label,
    ...(principal === undefined ? {} : { principal }),
    ...(connectionId === undefined ? {} : { connectionId }),
  };
}

function validateConnectionBindings(
  value: unknown
): readonly ConnectionBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ManifestError(
      "invalid_field",
      "manifest.connections must be an array",
      "connections"
    );
  }
  if (value.length === 0) return [];
  return value.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ManifestError(
        "invalid_field",
        `manifest.connections[${i}] must be an object`,
        "connections"
      );
    }
    const e = entry as Record<string, unknown>;
    return {
      connectionId: requireString(
        e.connectionId,
        `connections[${i}].connectionId`
      ),
      kind: requireString(e.kind, `connections[${i}].kind`),
      label: requireString(e.label, `connections[${i}].label`),
    };
  });
}

const VAULT_VERBS = new Set(["read", "read+act", "act", "reveal"]);
const VAULT_FILTER_OPS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is-null",
  "not-null",
  "within-days",
  "within-next-days",
]);

function validateVault(raw: unknown): ManifestVault | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_field",
      "manifest.vault must be an object",
      "vault"
    );
  }
  const v = raw as Record<string, unknown>;
  const purpose = requireString(v.purpose, "vault.purpose");
  let why: string | undefined;
  if (v.why !== undefined) {
    if (typeof v.why !== "string") {
      throw new ManifestError(
        "invalid_field",
        "manifest.vault.why must be a string",
        "vault.why"
      );
    }
    why = v.why;
  }
  if (!Array.isArray(v.scopes) || v.scopes.length === 0) {
    throw new ManifestError(
      "invalid_field",
      "manifest.vault.scopes must be a non-empty array",
      "vault.scopes"
    );
  }
  const scopes = v.scopes.map((rawLocal, i) => {
    const field = `vault.scopes[${i}]`;
    if (
      rawLocal === null ||
      typeof rawLocal !== "object" ||
      Array.isArray(rawLocal)
    ) {
      throw new ManifestError(
        "invalid_field",
        `manifest.${field} must be an object`,
        field
      );
    }
    const s = rawLocal as Record<string, unknown>;
    const schema = requireString(s.schema, `${field}.schema`);
    if (typeof s.verbs !== "string" || !VAULT_VERBS.has(s.verbs)) {
      throw new ManifestError(
        "invalid_field",
        `manifest.${field}.verbs must be "read" | "read+act" | "act" | "reveal"`,
        `${field}.verbs`
      );
    }
    let table: string | undefined;
    if (s.table !== undefined) table = requireString(s.table, `${field}.table`);
    let rowFilter: ManifestVaultFilterClause[] | undefined;
    if (s.rowFilter !== undefined) {
      if (!Array.isArray(s.rowFilter) || s.rowFilter.length === 0) {
        throw new ManifestError(
          "invalid_field",
          `manifest.${field}.rowFilter must be a non-empty array`,
          `${field}.rowFilter`
        );
      }
      rowFilter = s.rowFilter.map((rawClause, clauseIndex) => {
        const clauseField = `${field}.rowFilter[${clauseIndex}]`;
        if (
          rawClause === null ||
          typeof rawClause !== "object" ||
          Array.isArray(rawClause)
        ) {
          throw new ManifestError(
            "invalid_field",
            `manifest.${clauseField} must be an object`,
            clauseField
          );
        }
        const clause = rawClause as Record<string, unknown>;
        const column = requireString(clause.column, `${clauseField}.column`);
        if (typeof clause.op !== "string" || !VAULT_FILTER_OPS.has(clause.op)) {
          throw new ManifestError(
            "invalid_field",
            `manifest.${clauseField}.op is not a supported vault filter operator`,
            `${clauseField}.op`
          );
        }
        return {
          column,
          op: clause.op as ManifestVaultFilterClause["op"],
          ...(Object.hasOwn(clause, "value") ? { value: clause.value } : {}),
        };
      });
    }
    let fieldMask: string[] | undefined;
    if (s.fieldMask !== undefined) {
      if (!Array.isArray(s.fieldMask) || s.fieldMask.length === 0) {
        throw new ManifestError(
          "invalid_field",
          `manifest.${field}.fieldMask must be a non-empty array`,
          `${field}.fieldMask`
        );
      }
      fieldMask = s.fieldMask.map((value, maskIndex) =>
        requireString(value, `${field}.fieldMask[${maskIndex}]`)
      );
      if (new Set(fieldMask).size !== fieldMask.length) {
        throw new ManifestError(
          "invalid_field",
          `manifest.${field}.fieldMask must not contain duplicates`,
          `${field}.fieldMask`
        );
      }
    }
    if ((rowFilter || fieldMask) && table === undefined) {
      throw new ManifestError(
        "invalid_field",
        `manifest.${field}.table is required for rowFilter or fieldMask`,
        `${field}.table`
      );
    }
    return {
      schema,
      ...(table === undefined ? {} : { table }),
      verbs: s.verbs as ManifestVaultScope["verbs"],
      ...(rowFilter ? { rowFilter } : {}),
      ...(fieldMask ? { fieldMask } : {}),
    } satisfies ManifestVaultScope;
  });
  return { purpose, ...(why === undefined ? {} : { why }), scopes };
}

function validateSandbox(raw: unknown): ManifestSandbox | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_field",
      "manifest.sandbox must be an object",
      "sandbox"
    );
  }
  const lane = (raw as Record<string, unknown>).lane;
  if (lane !== "model-runtime" && lane !== "media-transcode") {
    throw new ManifestError(
      "invalid_field",
      "manifest.sandbox.lane must be one of model-runtime, media-transcode",
      "sandbox.lane"
    );
  }
  return { lane };
}

function validateEnrich(raw: unknown): ManifestEnrich | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_field",
      "manifest.enrich must be an object",
      "enrich"
    );
  }
  const e = raw as Record<string, unknown>;
  if (
    typeof e.domain !== "string" ||
    !(ENRICH_DOMAINS as readonly string[]).includes(e.domain)
  ) {
    throw new ManifestError(
      "invalid_field",
      `manifest.enrich.domain must be one of ${ENRICH_DOMAINS.join(", ")}`,
      "enrich.domain"
    );
  }
  const capability = requireString(e.capability, "enrich.capability");
  if (
    e.lane !== undefined &&
    !(ENRICH_LANES as readonly string[]).includes(e.lane as string)
  ) {
    throw new ManifestError(
      "invalid_field",
      `manifest.enrich.lane must be one of ${ENRICH_LANES.join(", ")}`,
      "enrich.lane"
    );
  }
  let delegateStep: ManifestEnrich["delegateStep"];
  if (e.delegateStep !== undefined) {
    if (
      e.delegateStep === null ||
      typeof e.delegateStep !== "object" ||
      Array.isArray(e.delegateStep)
    ) {
      throw new ManifestError(
        "invalid_field",
        "manifest.enrich.delegateStep must be an object",
        "enrich.delegateStep"
      );
    }
    const variant = e.delegateStep as Record<string, unknown>;
    if (
      variant.selected !== undefined &&
      variant.selected !== "deterministic" &&
      variant.selected !== "delegate"
    ) {
      throw new ManifestError(
        "invalid_field",
        "manifest.enrich.delegateStep.selected must be deterministic or delegate",
        "enrich.delegateStep.selected"
      );
    }
    delegateStep = {
      selected: variant.selected === "delegate" ? "delegate" : "deterministic",
      promptRev: requireString(
        variant.promptRev,
        "enrich.delegateStep.promptRev"
      ),
      latency: requireString(variant.latency, "enrich.delegateStep.latency"),
      consequence: requireString(
        variant.consequence,
        "enrich.delegateStep.consequence"
      ),
    };
  }
  return {
    domain: e.domain as EnrichDomain,
    capability,
    lane: (e.lane as EnrichLane | undefined) ?? "gateway",
    ...(delegateStep ? { delegateStep } : {}),
  };
}

function validateCostEstimate(raw: unknown): CostEstimate | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") {
    throw new ManifestError(
      "invalid_field",
      "manifest.costEstimate must be an object",
      "costEstimate"
    );
  }
  const ce = raw as Record<string, unknown>;
  const model = requireString(ce.model, "costEstimate.model");
  if (
    typeof ce.tokensPerFire !== "number" ||
    !Number.isFinite(ce.tokensPerFire) ||
    ce.tokensPerFire < 0
  ) {
    throw new ManifestError(
      "invalid_field",
      "manifest.costEstimate.tokensPerFire must be a non-negative finite number",
      "costEstimate.tokensPerFire"
    );
  }
  return { model, tokensPerFire: ce.tokensPerFire };
}

function validateOnFailure(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ManifestError(
      "invalid_on_failure",
      "manifest.onFailure must be a non-empty string naming another automation",
      "onFailure"
    );
  }
  if (!isValidRef(raw)) {
    throw new ManifestError(
      "invalid_on_failure",
      `manifest.onFailure "${raw}" is not a valid automation handle`,
      "onFailure"
    );
  }
  return raw;
}

export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ManifestError(
      "invalid_json",
      `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): Manifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_field", "manifest must be a JSON object");
  }
  const r = raw as Record<string, unknown>;

  const name = requireString(r.name, "name");
  const version =
    r.version === undefined ? "0.1.0" : requireString(r.version, "version");
  let description: string | undefined;
  if (r.description !== undefined) {
    if (typeof r.description !== "string") {
      throw new ManifestError(
        "invalid_field",
        "manifest.description must be a string",
        "description"
      );
    }
    description = r.description;
  }
  const enabled = r.enabled === undefined ? true : r.enabled === true;
  const notify =
    r.notify === undefined
      ? "failures"
      : r.notify === "always" || r.notify === "failures" || r.notify === "never"
        ? r.notify
        : undefined;
  if (!notify) {
    throw new ManifestError(
      "invalid_field",
      'manifest.notify must be "always", "failures", or "never"',
      "notify"
    );
  }
  const prompt = requireString(r.prompt, "prompt");
  const triggers = resolveTriggers(r);
  const requires = validateRequires(r.requires);
  const connector = validateConnector(r.connector);
  const connections = validateConnectionBindings(r.connections);
  const vault = validateVault(r.vault);
  const enrich = validateEnrich(r.enrich);
  const sandbox = validateSandbox(r.sandbox);
  if (connector && !vault) {
    throw new ManifestError(
      "invalid_field",
      "manifest.connector requires a manifest.vault block (connectors stage rows through sync.stage_rows)",
      "connector"
    );
  }
  if (!connector && requires.secrets && requires.secrets.length > 0) {
    throw new ManifestError(
      "invalid_field",
      "manifest.requires.secrets is connector-only (issue #293) — declare manifest.connector",
      "requires.secrets"
    );
  }
  if (
    !vault &&
    triggers.some((t) => t.kind === "condition" || t.kind === "data")
  ) {
    throw new ManifestError(
      "invalid_trigger",
      "manifest.triggers contains a condition/data trigger but no manifest.vault block declares the access it reads under",
      "vault"
    );
  }
  for (const trigger of triggers) {
    if (trigger.kind !== "event") continue;
    if (
      !connections?.some((binding) => binding.kind === trigger.connectorKind)
    ) {
      throw new ManifestError(
        "invalid_trigger",
        `manifest event trigger "${trigger.event}" requires a bound "${trigger.connectorKind}" connection`,
        "connections"
      );
    }
  }
  const apps = optionalStringArray(r.apps, "apps");
  const costEstimate = validateCostEstimate(r.costEstimate);
  const outputSchema = validateOutputSchema(r.outputSchema);
  const onFailure = validateOnFailure(r.onFailure);
  const history = validateHistory(r.history);

  const genRaw = r.generated;
  if (!genRaw || typeof genRaw !== "object" || Array.isArray(genRaw)) {
    throw new ManifestError(
      "missing_field",
      "manifest.generated must be an object",
      "generated"
    );
  }
  const gen = genRaw as Record<string, unknown>;
  const generated: GeneratedMeta = {
    by: requireString(gen.by, "generated.by"),
    at: requireString(gen.at, "generated.at"),
  };

  return {
    name,
    version,
    ...(description === undefined ? {} : { description }),
    enabled,
    notify,
    prompt,
    triggers,
    requires,
    ...(connector ? { connector } : {}),
    ...(connections === undefined ? {} : { connections }),
    ...(vault ? { vault } : {}),
    ...(enrich ? { enrich } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(apps ? { apps } : {}),
    ...(costEstimate ? { costEstimate } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(onFailure ? { onFailure } : {}),
    history,
    generated,
  };
}
