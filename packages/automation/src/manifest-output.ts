/**
 * Output-schema validator for automation handlers (issue #80).
 *
 * The handler's optional `return { summary, output }` is validated
 * against `manifest.outputSchema`. We keep the schema deliberately
 * minimal — `type: 'object'` + `properties` + `required` — enough to
 * flag obvious shape drift. Full JSON-Schema support is on the
 * roadmap, not in scope here.
 */

import { ManifestError } from './manifest-errors.js';

export interface OutputSchema {
  readonly type: 'object';
  readonly properties?: Record<
    string,
    { readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' }
  >;
  readonly required?: readonly string[];
}

const ALLOWED_PROP_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

export function validateOutputSchema(raw: unknown): OutputSchema | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(
      'invalid_output_schema',
      'manifest.outputSchema must be an object',
      'outputSchema',
    );
  }
  const s = raw as Record<string, unknown>;
  if (s.type !== 'object') {
    throw new ManifestError(
      'invalid_output_schema',
      'manifest.outputSchema.type must be "object" — only object schemas are supported today',
      'outputSchema.type',
    );
  }
  let properties: OutputSchema['properties'];
  if (s.properties !== undefined) {
    if (s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties)) {
      throw new ManifestError(
        'invalid_output_schema',
        'manifest.outputSchema.properties must be an object',
        'outputSchema.properties',
      );
    }
    const out: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array' }> = {};
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ManifestError(
          'invalid_output_schema',
          `manifest.outputSchema.properties.${key} must be an object with a "type" field`,
          `outputSchema.properties.${key}`,
        );
      }
      const v = value as Record<string, unknown>;
      if (typeof v.type !== 'string' || !ALLOWED_PROP_TYPES.has(v.type)) {
        throw new ManifestError(
          'invalid_output_schema',
          `manifest.outputSchema.properties.${key}.type must be one of: string|number|boolean|object|array`,
          `outputSchema.properties.${key}.type`,
        );
      }
      out[key] = { type: v.type as 'string' | 'number' | 'boolean' | 'object' | 'array' };
    }
    properties = out;
  }
  let required: readonly string[] | undefined;
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) {
      throw new ManifestError(
        'invalid_output_schema',
        'manifest.outputSchema.required must be an array of strings',
        'outputSchema.required',
      );
    }
    required = s.required.map((entry, idx) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new ManifestError(
          'invalid_output_schema',
          `manifest.outputSchema.required[${idx}] must be a non-empty string`,
          `outputSchema.required[${idx}]`,
        );
      }
      return entry;
    });
  }
  return {
    type: 'object',
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}

/**
 * Validate a handler's return `output` against `manifest.outputSchema`.
 * Returns null on pass, an error message on fail. Used by the runtime
 * to flip `runs.ok=0` and populate `runs.error` when the handler's
 * output doesn't match the declared shape.
 */
export function validateOutputAgainstSchema(schema: OutputSchema, output: unknown): string | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    const got = output === null ? 'null' : Array.isArray(output) ? 'array' : typeof output;
    return `output is not an object (got ${got})`;
  }
  const obj = output as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) return `missing required output property "${key}"`;
  }
  for (const [key, decl] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue;
    const value = obj[key];
    const actualType: string = Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : typeof value;
    if (actualType !== decl.type) {
      return `output property "${key}" expected type ${decl.type}, got ${actualType}`;
    }
  }
  return null;
}
