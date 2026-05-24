import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
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
  ],
  queries: [
    {
      name: 'list',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
});

describe('manifest constants', () => {
  it('exposes file name and version', () => {
    assert.equal(APP_MANIFEST_FILE, 'app.json');
    assert.equal(MANIFEST_VERSION, 1);
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = validateManifest(baseManifest());
    assert.equal(m.id, 'todos');
    assert.equal(m.actions.length, 1);
    assert.equal(m.queries.length, 1);
  });

  it('rejects non-object input', () => {
    assert.throws(
      () => validateManifest(null),
      (err: Error) => err instanceof ManifestError,
    );
    assert.throws(
      () => validateManifest('hi'),
      (err: Error) => err instanceof ManifestError,
    );
    assert.throws(
      () => validateManifest([]),
      (err: Error) => err instanceof ManifestError,
    );
  });

  it('rejects missing manifestVersion with a clear code', () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.manifestVersion;
    try {
      validateManifest(m);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ManifestError);
      assert.equal((err as ManifestError).code, 'unsupported_manifest_version');
    }
  });

  it('rejects an unsupported manifestVersion', () => {
    const m = baseManifest();
    (m as Record<string, unknown>).manifestVersion = 99;
    try {
      validateManifest(m);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ManifestError);
      assert.equal((err as ManifestError).code, 'unsupported_manifest_version');
    }
  });

  it('rejects missing required top-level fields', () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.id;
    assert.throws(
      () => validateManifest(m),
      (err: Error) => {
        return err instanceof ManifestError && err.code === 'invalid_manifest';
      },
    );
  });

  it('rejects an action with invalid confirmation', () => {
    const m = baseManifest();
    (m.actions[0] as { confirmation: string }).confirmation = 'sometimes';
    assert.throws(
      () => validateManifest(m),
      (err: Error) => err instanceof ManifestError,
    );
  });

  it('rejects duplicate action names', () => {
    const m = baseManifest();
    m.actions.push({ ...m.actions[0]! });
    try {
      validateManifest(m);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ManifestError);
      assert.equal((err as ManifestError).code, 'duplicate_handler');
    }
  });

  it('allows the same name in actions and queries', () => {
    const m = baseManifest();
    m.queries.push({
      name: 'add',
      input: { type: 'object', properties: {}, additionalProperties: false },
    });
    const out = validateManifest(m);
    assert.equal(out.queries.length, 2);
  });

  it('treats tables as optional', () => {
    const m = baseManifest();
    const out = validateManifest(m);
    assert.equal(out.tables, undefined);
  });
});

describe('parseManifest', () => {
  it('parses well-formed JSON', () => {
    const out = parseManifest(JSON.stringify(baseManifest()));
    assert.equal(out.name, 'Todos');
  });

  it('rejects invalid JSON with code invalid_json', () => {
    try {
      parseManifest('not json');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ManifestError);
      assert.equal((err as ManifestError).code, 'invalid_json');
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
    assert.equal(validate({ id: 5 }), true);
    assert.equal(validate({}), false);
    assert.equal(validate({ id: 'x' }), false);
  });
});

describe('findAction / findQuery', () => {
  it('looks up by name', () => {
    const m = validateManifest(baseManifest());
    assert.equal(findAction(m, 'add')?.name, 'add');
    assert.equal(findAction(m, 'missing'), undefined);
    assert.equal(findQuery(m, 'list')?.name, 'list');
    assert.equal(findQuery(m, 'missing'), undefined);
  });
});
