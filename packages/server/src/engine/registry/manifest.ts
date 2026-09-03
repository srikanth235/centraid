// governance: allow-repo-hygiene file-size-limit the manifest types, their JSON meta-schema and the validator only ever change together

import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

export const MANIFEST_VERSION = 1;

export const APP_MANIFEST_FILE = "app.json";

export type ManifestValidationCode =
  | "invalid_json"
  | "invalid_manifest"
  | "unsupported_manifest_version"
  | "missing_field"
  | "invalid_field"
  | "invalid_handler_entry"
  | "duplicate_handler"
  | "reserved_handler_name";

export const RESERVED_HANDLER_PREFIX = "_";

export function isReservedHandlerName(name: string): boolean {
  return name.startsWith(RESERVED_HANDLER_PREFIX);
}

export class ManifestError extends Error {
  readonly code: ManifestValidationCode;
  readonly path?: string;
  constructor(code: ManifestValidationCode, message: string, path?: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export type JsonSchema = Record<string, unknown>;

export type HandlerConfirmation = "none" | "required";
export type AppActionSideEffect = "vault-write";

export interface ManifestActionEntry {
  readonly name: string;
  readonly description?: string;
  readonly confirmation: HandlerConfirmation;
  readonly input: JsonSchema;
  readonly output?: JsonSchema;
  readonly writes?: readonly string[];
}

export interface ManifestQueryEntry {
  readonly name: string;
  readonly description?: string;
  readonly input: JsonSchema;
  readonly output?: JsonSchema;
  readonly reads?: readonly string[];
}

export interface ManifestKnobOption {
  readonly value: string;
  readonly label: string;
}
export interface ManifestKnob {
  readonly key: string;
  readonly label: string;
  readonly type: "segmented" | "swatch";
  readonly default: string;
  readonly options: readonly ManifestKnobOption[];
}

export interface ManifestVaultScope {
  readonly schema: string;
  readonly table?: string;
  readonly verbs: "read" | "read+act" | "act" | "reveal";
  readonly rowFilter?: readonly {
    readonly column: string;
    readonly op: string;
    readonly value?: unknown;
  }[];
  readonly fieldMask?: readonly string[];
}

export interface ManifestVaultBlock {
  readonly purpose: string;
  readonly why?: string;
  readonly scopes: readonly ManifestVaultScope[];
}

export interface ManifestExtColumn {
  readonly name: string;
  readonly type: "text" | "integer" | "real" | "blob";
  readonly primaryKey?: boolean;
  readonly notNull?: boolean;
  readonly default?: string | number;
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
  readonly searchable?: readonly string[];
}

export interface ManifestExtBlock {
  readonly tables: readonly ManifestExtTable[];
}

export interface ManifestSeatsBlock {
  readonly byteBearing: boolean;
  readonly originActs: readonly string[];
  readonly disabledOn: readonly string[];
  readonly northStar: string;
}

export const CANONICAL_DESIGNED_STATES = [
  "dayone",
  "pending",
  "offline",
  "stale",
  "conflict",
  "parked",
  "denied",
] as const;

export type ManifestDesignedState = (typeof CANONICAL_DESIGNED_STATES)[number];

export interface ManifestStateExclusion {
  readonly state: ManifestDesignedState;
  readonly reason: string;
  readonly citation: string;
}

export interface ManifestStatesBlock {
  readonly designed: readonly ManifestDesignedState[];
  readonly excluded: readonly ManifestStateExclusion[];
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind?: "app" | "automation";
  readonly description?: string;
  readonly actionSideEffect?: AppActionSideEffect;
  readonly actions: readonly ManifestActionEntry[];
  readonly queries: readonly ManifestQueryEntry[];
  readonly knobs?: readonly ManifestKnob[];
  readonly vault?: ManifestVaultBlock;
  readonly ext?: ManifestExtBlock;
  readonly seats?: ManifestSeatsBlock;
  readonly states?: ManifestStatesBlock;
}

export const MANIFEST_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://centraid.dev/schemas/app-manifest/v1.json",
  type: "object",
  required: ["manifestVersion", "id", "name", "version"],
  additionalProperties: true,
  properties: {
    manifestVersion: { type: "integer", const: MANIFEST_VERSION },
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["app", "automation"] },
    description: { type: "string" },
    actionSideEffect: { type: "string", enum: ["vault-write"] },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "confirmation", "input"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          confirmation: { type: "string", enum: ["none", "required"] },
          input: { type: "object" },
          output: { type: "object" },
          writes: { type: "array", items: { type: "string" } },
        },
      },
    },
    queries: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "input"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          input: { type: "object" },
          output: { type: "object" },
          reads: { type: "array", items: { type: "string" } },
        },
      },
    },
    ext: {
      type: "object",
      required: ["tables"],
      properties: {
        tables: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "columns"],
            properties: {
              name: { type: "string", minLength: 1 },
              columns: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["name", "type"],
                  properties: {
                    name: { type: "string", minLength: 1 },
                    type: {
                      type: "string",
                      enum: ["text", "integer", "real", "blob"],
                    },
                    primaryKey: { type: "boolean" },
                    notNull: { type: "boolean" },
                    default: { type: ["string", "number"] },
                    references: { type: "string", minLength: 1 },
                  },
                },
              },
              indexes: {
                type: "array",
                items: {
                  type: "object",
                  required: ["columns"],
                  properties: {
                    columns: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string" },
                    },
                    unique: { type: "boolean" },
                  },
                },
              },
              searchable: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    vault: {
      type: "object",
      required: ["purpose", "scopes"],
      properties: {
        purpose: { type: "string", minLength: 1 },
        why: { type: "string" },
        scopes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["schema", "verbs"],
            properties: {
              schema: { type: "string", minLength: 1 },
              table: { type: "string", minLength: 1 },
              verbs: {
                type: "string",
                enum: ["read", "read+act", "act", "reveal"],
              },
              rowFilter: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["column", "op"],
                  properties: {
                    column: { type: "string", minLength: 1 },
                    op: { type: "string", minLength: 1 },
                    value: {},
                  },
                },
              },
              fieldMask: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    seats: {
      type: "object",
      required: ["byteBearing", "originActs", "disabledOn", "northStar"],
      additionalProperties: false,
      properties: {
        byteBearing: { type: "boolean" },
        originActs: { type: "array", items: { type: "string" } },
        disabledOn: { type: "array", items: { type: "string" } },
        northStar: { type: "string", minLength: 1 },
      },
    },
    states: {
      type: "object",
      required: ["designed", "excluded"],
      additionalProperties: false,
      properties: {
        designed: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", enum: [...CANONICAL_DESIGNED_STATES] },
        },
        excluded: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["state", "reason", "citation"],
            properties: {
              state: { type: "string", enum: [...CANONICAL_DESIGNED_STATES] },
              reason: { type: "string", minLength: 1 },
              citation: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    knobs: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "label", "type", "default", "options"],
        properties: {
          key: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["segmented", "swatch"] },
          default: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              required: ["value", "label"],
              properties: {
                value: { type: "string" },
                label: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

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
  if (!manifestValidator)
    manifestValidator = getAjv().compile(MANIFEST_JSON_SCHEMA);
  return manifestValidator;
}

export function compileSchema(schema: JsonSchema): ValidateFunction {
  return getAjv().compile(schema);
}

export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ManifestError(
      "invalid_json",
      `app.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): Manifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(
      "invalid_manifest",
      "manifest must be a JSON object"
    );
  }
  const r = raw as Record<string, unknown>;

  if (r.manifestVersion === undefined) {
    throw new ManifestError(
      "unsupported_manifest_version",
      `app.json is missing "manifestVersion"; expected ${MANIFEST_VERSION}`,
      "manifestVersion"
    );
  }
  if (r.manifestVersion !== MANIFEST_VERSION) {
    throw new ManifestError(
      "unsupported_manifest_version",
      `app.json declares manifestVersion ${String(r.manifestVersion)}, but this runtime understands ${MANIFEST_VERSION}`,
      "manifestVersion"
    );
  }

  const validate = getManifestValidator();
  if (!validate(raw)) {
    const errs = validate.errors ?? [];
    const first = errs[0];
    const path = first?.instancePath || "";
    const msg = first?.message ?? "manifest failed schema validation";
    throw new ManifestError(
      "invalid_manifest",
      `manifest invalid: ${msg}`,
      path
    );
  }

  const actions = (r.actions as ManifestActionEntry[] | undefined) ?? [];
  const queries = (r.queries as ManifestQueryEntry[] | undefined) ?? [];

  const seenActions = new Set<string>();
  for (const a of actions) {
    if (isReservedHandlerName(a.name)) {
      throw new ManifestError(
        "reserved_handler_name",
        `action name "${a.name}" is reserved; names starting with "${RESERVED_HANDLER_PREFIX}" are dispatched to built-in handlers`,
        `actions[name=${a.name}]`
      );
    }
    if (seenActions.has(a.name)) {
      throw new ManifestError(
        "duplicate_handler",
        `manifest declares the action "${a.name}" twice`,
        `actions[name=${a.name}]`
      );
    }
    seenActions.add(a.name);
  }
  const seenQueries = new Set<string>();
  for (const q of queries) {
    if (isReservedHandlerName(q.name)) {
      throw new ManifestError(
        "reserved_handler_name",
        `query name "${q.name}" is reserved; names starting with "${RESERVED_HANDLER_PREFIX}" are dispatched to built-in handlers`,
        `queries[name=${q.name}]`
      );
    }
    if (seenQueries.has(q.name)) {
      throw new ManifestError(
        "duplicate_handler",
        `manifest declares the query "${q.name}" twice`,
        `queries[name=${q.name}]`
      );
    }
    seenQueries.add(q.name);
  }

  const states = r.states as ManifestStatesBlock | undefined;
  if (states && typeof states === "object") {
    const claimed = new Map<ManifestDesignedState, "designed" | "excluded">();
    const claim = (
      state: ManifestDesignedState,
      side: "designed" | "excluded"
    ): void => {
      const prior = claimed.get(state);
      if (prior !== undefined) {
        throw new ManifestError(
          "invalid_field",
          `states declares "${state}" twice (${prior}, then ${side}); each canonical state belongs to exactly one side`,
          `states.${side}`
        );
      }
      claimed.set(state, side);
    };
    for (const state of states.designed) claim(state, "designed");
    for (const entry of states.excluded) claim(entry.state, "excluded");
    const missing = CANONICAL_DESIGNED_STATES.filter(
      (state) => !claimed.has(state)
    );
    if (missing.length > 0) {
      throw new ManifestError(
        "invalid_field",
        `states omits ${missing.join(", ")}; list every canonical state under "designed", or under "excluded" with a reason and a citation`,
        "states"
      );
    }
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    id: r.id as string,
    name: r.name as string,
    version: r.version as string,
    ...(r.kind === "automation" || r.kind === "app" ? { kind: r.kind } : {}),
    ...(typeof r.description === "string"
      ? { description: r.description }
      : {}),
    ...(r.actionSideEffect === "vault-write"
      ? { actionSideEffect: r.actionSideEffect }
      : {}),
    actions,
    queries,
    ...(Array.isArray(r.knobs) ? { knobs: r.knobs as ManifestKnob[] } : {}),
    ...(r.vault && typeof r.vault === "object"
      ? { vault: r.vault as ManifestVaultBlock }
      : {}),
    ...(r.ext && typeof r.ext === "object"
      ? { ext: r.ext as ManifestExtBlock }
      : {}),
    ...(r.seats && typeof r.seats === "object"
      ? { seats: r.seats as ManifestSeatsBlock }
      : {}),
    ...(states ? { states } : {}),
  };
}

export function findAction(
  manifest: Manifest,
  name: string
): ManifestActionEntry | undefined {
  return manifest.actions.find((a) => a.name === name);
}

export function findQuery(
  manifest: Manifest,
  name: string
): ManifestQueryEntry | undefined {
  return manifest.queries.find((q) => q.name === name);
}
