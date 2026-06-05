import { describe, expect, it } from 'vitest';
import {
  APP_MANIFEST_FILE,
  MANIFEST_VERSION,
  ManifestError,
  compileSchema,
  findAction,
  findQuery,
  parseManifest,
  validateManifest,
} from './manifest.js';

const baseManifest = () => ({
  manifestVersion: MANIFEST_VERSION,
  id: 'todos',
  name: 'Todos',
  version: '0.1.0',
  description: 'tests',
  // Loosely typed: these tests deliberately mutate/push partial and malformed
  // actions/queries and feed the result to validateManifest(raw: unknown), so
  // the fixture must not pin the arrays to the first element's narrow shape.
  actions: [
    {
      name: 'add',
      confirmation: 'none',
      input: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ] as Array<Record<string, unknown>>,
  queries: [
    {
      name: 'list',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ] as Array<Record<string, unknown>>,
});

describe('manifest constants', () => {
  it('exposes file name and version', () => {
    expect(APP_MANIFEST_FILE).toBe('app.json');
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = validateManifest(baseManifest());
    expect(m.id).toBe('todos');
    expect(m.actions.length).toBe(1);
    expect(m.queries.length).toBe(1);
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest(null)).toThrow(ManifestError);
    expect(() => validateManifest('hi')).toThrow(ManifestError);
    expect(() => validateManifest([])).toThrow(ManifestError);
  });

  it('rejects missing manifestVersion with a clear code', () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.manifestVersion;
    try {
      validateManifest(m);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('unsupported_manifest_version');
    }
  });

  it('rejects an unsupported manifestVersion', () => {
    const m = baseManifest();
    (m as Record<string, unknown>).manifestVersion = 99;
    try {
      validateManifest(m);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('unsupported_manifest_version');
    }
  });

  it('rejects missing required top-level fields', () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.id;
    let err: unknown;
    try {
      validateManifest(m);
    } catch (e) {
      err = e;
    }
    expect(err instanceof ManifestError).toBeTruthy();
    expect((err as ManifestError).code).toBe('invalid_manifest');
  });

  it('rejects an action with invalid confirmation', () => {
    const m = baseManifest();
    (m.actions[0] as { confirmation: string }).confirmation = 'sometimes';
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  it('rejects duplicate action names', () => {
    const m = baseManifest();
    m.actions.push({ ...m.actions[0]! });
    try {
      validateManifest(m);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('duplicate_handler');
    }
  });

  it('rejects an action whose name starts with the reserved "_" prefix', () => {
    const m = baseManifest();
    m.actions.push({
      name: '_sql',
      confirmation: 'none' as const,
      input: { type: 'object' },
    });
    try {
      validateManifest(m);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('reserved_handler_name');
    }
  });

  it('rejects a query whose name starts with the reserved "_" prefix', () => {
    const m = baseManifest();
    m.queries.push({
      name: '_sql',
      input: { type: 'object' },
    });
    try {
      validateManifest(m);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('reserved_handler_name');
    }
  });

  it('allows the same name in actions and queries', () => {
    const m = baseManifest();
    m.queries.push({
      name: 'add',
      input: { type: 'object', properties: {}, additionalProperties: false },
    });
    const out = validateManifest(m);
    expect(out.queries.length).toBe(2);
  });

  it('treats tables as optional', () => {
    const m = baseManifest();
    const out = validateManifest(m);
    expect(out.tables).toBe(undefined);
  });

  it('omits kind when absent and carries an automation kind through', () => {
    // No `kind` → a normal UI app; the field is simply absent.
    expect(validateManifest(baseManifest()).kind).toBe(undefined);
    // `kind: 'automation'` marks a UI-less automation app (replaces the
    // legacy `auto.` id prefix) and round-trips through validation.
    const auto = { ...baseManifest(), kind: 'automation' };
    expect(validateManifest(auto).kind).toBe('automation');
  });

  it('rejects an unknown kind value', () => {
    const m = { ...baseManifest(), kind: 'widget' };
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });
});

describe('parseManifest', () => {
  it('parses well-formed JSON', () => {
    const out = parseManifest(JSON.stringify(baseManifest()));
    expect(out.name).toBe('Todos');
  });

  it('rejects invalid JSON with code invalid_json', () => {
    try {
      parseManifest('not json');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ManifestError).toBeTruthy();
      expect((err as ManifestError).code).toBe('invalid_json');
    }
  });
});

describe('compileSchema + Ajv round-trip', () => {
  it('compiles a schema and validates against it', () => {
    const validate = compileSchema({
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    });
    expect(validate({ id: 5 })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ id: 'x' })).toBe(false);
  });
});

describe('findAction / findQuery', () => {
  it('looks up by name', () => {
    const m = validateManifest(baseManifest());
    expect(findAction(m, 'add')?.name).toBe('add');
    expect(findAction(m, 'missing')).toBe(undefined);
    expect(findQuery(m, 'list')?.name).toBe('list');
    expect(findQuery(m, 'missing')).toBe(undefined);
  });
});
