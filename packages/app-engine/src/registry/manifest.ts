// governance: allow-repo-hygiene file-size-limit the manifest types + their one JSON meta-schema + the validator must move together — the ext block (#286) grew all three in lockstep
/**
 * App manifest — the per-app machine-readable contract the dispatcher
 * routes declared handlers against (issue #107, narrowed by #286 phase 2).
 *
 * The manifest lives on disk as `app.json` inside each app's code dir
 * (alongside `actions/`, `queries/`). It is the single source of truth
 * for "what handlers exist, what input do they accept, what do they
 * return" — handler files themselves are pure function bodies, no
 * JSDoc-driven validation — plus the app's whole data declaration: the
 * `vault` block (requested canonical scopes) and the `ext` block
 * (extension tables the gateway hosts inside vault.db).
 *
 * Schemas in `input` / `output` are arbitrary JSON Schema (draft
 * 2020-12) — that's what Anthropic tool-use, OpenAI functions, MCP and
 * OpenAPI all consume, and what the builder LLM natively knows how to
 * emit. They are validated at call time by Ajv (see `dispatcher.ts`).
 *
 * `manifestVersion: 1` is required at the root — the dispatcher rejects
 * unsupported versions explicitly so future incompatible changes fail
 * loudly. Cheap insurance.
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Ajv2020 is both value (constructor) and type (instance). (#247)
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

/** Current manifest schema version. Bump on any incompatible field change. */
export const MANIFEST_VERSION = 1;

/** Filename inside an app's code dir. */
export const APP_MANIFEST_FILE = 'app.json';

export type ManifestValidationCode =
  | 'invalid_json'
  | 'invalid_manifest'
  | 'unsupported_manifest_version'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_handler_entry'
  | 'duplicate_handler'
  | 'reserved_handler_name';

/**
 * Names starting with `_` are reserved (they once addressed built-ins
 * like `_sql`; the builtins are gone but the namespace stays reserved).
 * App authors cannot declare an action or query with such a name —
 * `validateManifest` refuses it explicitly at load time.
 */
export const RESERVED_HANDLER_PREFIX = '_';

export function isReservedHandlerName(name: string): boolean {
  return name.startsWith(RESERVED_HANDLER_PREFIX);
}

export class ManifestError extends Error {
  readonly code: ManifestValidationCode;
  readonly path?: string;
  constructor(code: ManifestValidationCode, message: string, path?: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** A JSON Schema fragment — kept as an opaque record. Validated by Ajv at use. */
export type JsonSchema = Record<string, unknown>;

export type HandlerConfirmation = 'none' | 'required';

export interface ManifestActionEntry {
  readonly name: string;
  readonly description?: string;
  /**
   * Chat-side confirmation policy. The dispatcher itself is
   * permissionless — the chat/agent surface checks this field before
   * invoking autonomously and prompts the user when `"required"`.
   * Multi-caller RBAC is a follow-up; this is the v1 lever.
   */
  readonly confirmation: HandlerConfirmation;
  readonly input: JsonSchema;
  readonly output?: JsonSchema;
  /** Tables this action writes — surfaced for chat permissions / docs. */
  readonly writes?: readonly string[];
}

export interface ManifestQueryEntry {
  readonly name: string;
  readonly description?: string;
  readonly input: JsonSchema;
  readonly output?: JsonSchema;
  readonly reads?: readonly string[];
}

/**
 * One per-app aesthetic knob — declared in `app.json#knobs` and surfaced
 * in the desktop's per-app settings popover. The runtime routes any
 * `app*` key dynamically (see `settings-merge.ts`), so adding/removing
 * a knob is purely a manifest edit + matching CSS in `app.css`.
 */
export interface ManifestKnobOption {
  readonly value: string;
  readonly label: string;
}
export interface ManifestKnob {
  /** Camel-cased `app*` settings key (e.g. `appFont`, `appColor`). */
  readonly key: string;
  /** Display label shown in the popover row. */
  readonly label: string;
  /** Control type. `segmented` for discrete values, `swatch` for colour. */
  readonly type: 'segmented' | 'swatch';
  /** Value to assume when the per-app table has no row for this knob. */
  readonly default: string;
  /** Choices the user picks from. */
  readonly options: readonly ManifestKnobOption[];
}

/** One vault scope an app requests: schema-wide or a single table. */
export interface ManifestVaultScope {
  readonly schema: string;
  readonly table?: string;
  readonly verbs: 'read' | 'read+act' | 'act';
}

/**
 * Declared personal-vault access (duaility §12). The block is a *request*,
 * not a grant: the owner approves it explicitly (deny-by-default until
 * then) and the host records the consent in the vault's own model.
 * `purpose` is a DPV notation, e.g. `dpv:ServiceProvision`.
 */
export interface ManifestVaultBlock {
  readonly purpose: string;
  /** Owner-facing rationale shown in the approval UI. */
  readonly why?: string;
  readonly scopes: readonly ManifestVaultScope[];
}

/**
 * The ext band (issue #286 phase 2, Lane 2 of the two-lane rule): tables
 * the app declares and the GATEWAY creates inside vault.db as
 * `ext_<appId>_<table>` — for shapes the canonical ontology genuinely
 * doesn't cover. Structurally mirrors the vault package's `ExtTableSpec`
 * (app-engine stays vault-agnostic; the gateway host validates the specs
 * with the vault's own validator before applying).
 */
export interface ManifestExtColumn {
  readonly name: string;
  readonly type: 'text' | 'integer' | 'real' | 'blob';
  readonly primaryKey?: boolean;
  readonly notNull?: boolean;
  readonly default?: string | number;
  /** FK into the vault (`core.party`) or a same-app ext table. */
  readonly references?: string;
}

export interface ManifestExtIndex {
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

export interface ManifestExtTable {
  readonly name: string;
  readonly columns: readonly ManifestExtColumn[];
  readonly indexes?: readonly ManifestExtIndex[];
  /** Text columns to FTS-index (opt-in search). */
  readonly searchable?: readonly string[];
}

export interface ManifestExtBlock {
  readonly tables: readonly ManifestExtTable[];
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /**
   * What surface the app belongs to. `'automation'` marks a UI-less app
   * that exists only to host automations (it shows on the Automations
   * page, not "My apps"); `'app'` — the default when omitted — is a normal
   * UI app. This replaces the legacy `auto.`-id-prefix convention: the
   * manifest, not the folder id, is the source of truth for "is this an
   * automation app".
   */
  readonly kind?: 'app' | 'automation';
  readonly description?: string;
  readonly actions: readonly ManifestActionEntry[];
  readonly queries: readonly ManifestQueryEntry[];
  /** Per-app aesthetic knobs (font, width, radius, colour…). Optional. */
  readonly knobs?: readonly ManifestKnob[];
  /** Requested personal-vault access (duaility §12). Optional. */
  readonly vault?: ManifestVaultBlock;
  /** Declared extension tables, hosted inside vault.db (#286). Optional. */
  readonly ext?: ManifestExtBlock;
}

// ----------------------------------------------------------------------------
// Meta-schema document — the JSON Schema *for the manifest itself*. Exported
// so builder consumers (and external tooling) can validate `app.json` against
// it without depending on our runtime module.
// ----------------------------------------------------------------------------
export const MANIFEST_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://centraid.dev/schemas/app-manifest/v1.json',
  type: 'object',
  required: ['manifestVersion', 'id', 'name', 'version'],
  additionalProperties: true,
  properties: {
    manifestVersion: { type: 'integer', const: MANIFEST_VERSION },
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['app', 'automation'] },
    description: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'confirmation', 'input'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          confirmation: { type: 'string', enum: ['none', 'required'] },
          input: { type: 'object' },
          output: { type: 'object' },
          writes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    queries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'input'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          input: { type: 'object' },
          output: { type: 'object' },
          reads: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    ext: {
      type: 'object',
      required: ['tables'],
      properties: {
        tables: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'columns'],
            properties: {
              name: { type: 'string', minLength: 1 },
              columns: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    type: { type: 'string', enum: ['text', 'integer', 'real', 'blob'] },
                    primaryKey: { type: 'boolean' },
                    notNull: { type: 'boolean' },
                    default: { type: ['string', 'number'] },
                    references: { type: 'string', minLength: 1 },
                  },
                },
              },
              indexes: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['columns'],
                  properties: {
                    columns: { type: 'array', minItems: 1, items: { type: 'string' } },
                    unique: { type: 'boolean' },
                  },
                },
              },
              searchable: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    vault: {
      type: 'object',
      required: ['purpose', 'scopes'],
      properties: {
        purpose: { type: 'string', minLength: 1 },
        why: { type: 'string' },
        scopes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['schema', 'verbs'],
            properties: {
              schema: { type: 'string', minLength: 1 },
              table: { type: 'string', minLength: 1 },
              verbs: { type: 'string', enum: ['read', 'read+act', 'act'] },
            },
          },
        },
      },
    },
    knobs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'label', 'type', 'default', 'options'],
        properties: {
          key: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['segmented', 'swatch'] },
          default: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['value', 'label'],
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

// ----------------------------------------------------------------------------
// Validators
// ----------------------------------------------------------------------------

/**
 * Shared Ajv instance for input/output schema validation. Configured for
 * draft 2020-12 (the schema dialect the manifest uses).
 *
 * `coerceTypes` is off — handler inputs come from JSON so the types are
 * already settled. `useDefaults` is off — we don't want a JSON Schema
 * default to mask a missing required field. `removeAdditional` is off —
 * the manifest may set `additionalProperties: true` deliberately.
 */
let sharedAjv: Ajv2020 | undefined;
function getAjv(): Ajv2020 {
  if (!sharedAjv) {
    sharedAjv = new Ajv2020({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
  }
  return sharedAjv;
}

let manifestValidator: ValidateFunction | undefined;
function getManifestValidator(): ValidateFunction {
  if (!manifestValidator) manifestValidator = getAjv().compile(MANIFEST_JSON_SCHEMA);
  return manifestValidator;
}

/**
 * Compile a JSON Schema into an Ajv validator. Throws if the schema
 * itself is malformed. Callers cache by reference (typically per
 * codeDir + handler name) to avoid recompiling per call.
 */
export function compileSchema(schema: JsonSchema): ValidateFunction {
  return getAjv().compile(schema);
}

/**
 * Format an Ajv error array into a single `{path, message}` pair. We
 * surface the first error since the chat-facing error format only
 * carries one message.
 */
export function formatAjvErrors(validate: ValidateFunction): {
  path: string;
  message: string;
} {
  const errs = validate.errors ?? [];
  if (errs.length === 0) return { path: '', message: 'validation failed' };
  const first = errs[0]!;
  const path =
    first.instancePath || (first.params as { missingProperty?: string }).missingProperty
      ? first.instancePath ||
        `/${(first.params as { missingProperty?: string }).missingProperty ?? ''}`
      : '';
  return {
    path,
    message: first.message ?? 'validation failed',
  };
}

/**
 * Parse + validate `app.json` content. Throws `ManifestError` on any
 * shape problem.
 */
export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ManifestError(
      'invalid_json',
      `app.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(raw);
}

/**
 * Validate a parsed manifest object. Returns the typed manifest on
 * success; throws `ManifestError` on any shape problem.
 *
 * Validation runs in two passes:
 *   1. Ajv against `MANIFEST_JSON_SCHEMA` — catches type / required
 *      field problems with structured error paths.
 *   2. Manual cross-cuts — `manifestVersion` mustmatch, no duplicate
 *      handler names within an app.
 */
export function validateManifest(raw: unknown): Manifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('invalid_manifest', 'manifest must be a JSON object');
  }
  const r = raw as Record<string, unknown>;

  // Explicit, friendly check for missing manifestVersion — Ajv's
  // "required" error is less actionable for the most common drift case.
  if (r.manifestVersion === undefined) {
    throw new ManifestError(
      'unsupported_manifest_version',
      `app.json is missing "manifestVersion"; expected ${MANIFEST_VERSION}`,
      'manifestVersion',
    );
  }
  if (r.manifestVersion !== MANIFEST_VERSION) {
    throw new ManifestError(
      'unsupported_manifest_version',
      `app.json declares manifestVersion ${String(r.manifestVersion)}, but this runtime understands ${MANIFEST_VERSION}`,
      'manifestVersion',
    );
  }

  const validate = getManifestValidator();
  if (!validate(raw)) {
    const errs = validate.errors ?? [];
    const first = errs[0];
    const path = first?.instancePath || '';
    const msg = first?.message ?? 'manifest failed schema validation';
    throw new ManifestError('invalid_manifest', `manifest invalid: ${msg}`, path);
  }

  // Cross-cut: detect duplicate handler names. The same name appearing
  // in both actions and queries is *allowed* — they're invoked through
  // different tools — but two actions with the same name would mean the
  // dispatcher silently picks one, which is a footgun.
  const actions = (r.actions as ManifestActionEntry[] | undefined) ?? [];
  const queries = (r.queries as ManifestQueryEntry[] | undefined) ?? [];

  const seenActions = new Set<string>();
  for (const a of actions) {
    if (isReservedHandlerName(a.name)) {
      throw new ManifestError(
        'reserved_handler_name',
        `action name "${a.name}" is reserved; names starting with "${RESERVED_HANDLER_PREFIX}" are dispatched to built-in handlers`,
        `actions[name=${a.name}]`,
      );
    }
    if (seenActions.has(a.name)) {
      throw new ManifestError(
        'duplicate_handler',
        `manifest declares the action "${a.name}" twice`,
        `actions[name=${a.name}]`,
      );
    }
    seenActions.add(a.name);
  }
  const seenQueries = new Set<string>();
  for (const q of queries) {
    if (isReservedHandlerName(q.name)) {
      throw new ManifestError(
        'reserved_handler_name',
        `query name "${q.name}" is reserved; names starting with "${RESERVED_HANDLER_PREFIX}" are dispatched to built-in handlers`,
        `queries[name=${q.name}]`,
      );
    }
    if (seenQueries.has(q.name)) {
      throw new ManifestError(
        'duplicate_handler',
        `manifest declares the query "${q.name}" twice`,
        `queries[name=${q.name}]`,
      );
    }
    seenQueries.add(q.name);
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    id: r.id as string,
    name: r.name as string,
    version: r.version as string,
    ...(r.kind === 'automation' || r.kind === 'app' ? { kind: r.kind } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    actions,
    queries,
    ...(Array.isArray(r.knobs) ? { knobs: r.knobs as ManifestKnob[] } : {}),
    ...(r.vault && typeof r.vault === 'object' ? { vault: r.vault as ManifestVaultBlock } : {}),
    ...(r.ext && typeof r.ext === 'object' ? { ext: r.ext as ManifestExtBlock } : {}),
  };
}

/** Look up an action entry by name. */
export function findAction(manifest: Manifest, name: string): ManifestActionEntry | undefined {
  return manifest.actions.find((a) => a.name === name);
}

/** Look up a query entry by name. */
export function findQuery(manifest: Manifest, name: string): ManifestQueryEntry | undefined {
  return manifest.queries.find((q) => q.name === name);
}
