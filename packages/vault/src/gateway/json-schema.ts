// Minimal JSON-Schema validator for command input/output contracts (S3).
// Supports the subset the ontology's command contracts use: type, required,
// properties, additionalProperties, enum, const, items, minimum/maximum,
// minLength/pattern. Deliberately dependency-free like the rest of the repo.

interface Schema {
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) {
    errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => check(schema.items as Schema, item, `${path}[${i}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) check(sub, obj[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

/** Validate a value; returns a list of violations (empty = valid). */
export function validateJson(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];
  check(schema as Schema, value, '$', errors);
  return errors;
}
