/**
 * Matrix cell blueprints.contracts (#535 coverable-today).
 * App id + scaffold file-map contract is the public surface for builders.
 */
import { describe, expect, it } from 'vitest';
import { scaffoldAppFiles, validateAppId } from './scaffold-files.js';
import { AppScaffoldError } from './scaffold-types.js';

describe('blueprint scaffold contracts', () => {
  it('validateAppId accepts canonical slugs and rejects reserved/invalid forms', () => {
    expect(() => validateAppId('todos')).not.toThrow();
    expect(() => validateAppId('my-app-123')).not.toThrow();
    expect(() => validateAppId('_hidden')).toThrow(AppScaffoldError);
    expect(() => validateAppId('Upper')).toThrow(AppScaffoldError);
    expect(() => validateAppId('has.dot')).toThrow(AppScaffoldError);
    expect(() => validateAppId('')).toThrow(AppScaffoldError);
  });

  it('scaffoldAppFiles always emits a complete file map for a valid id', () => {
    const files = scaffoldAppFiles('contracts-app', { name: 'Contracts' });
    const paths = new Set(files.map((f) => f.path));
    for (const required of [
      'package.json',
      'app.json',
      'index.html',
      'app.css',
      'app.js',
      'README.md',
      'automations/README.md',
    ]) {
      expect(paths.has(required), required).toBe(true);
    }
    const appJson = JSON.parse(files.find((f) => f.path === 'app.json')!.content) as {
      id: string;
      name: string;
      manifestVersion: number;
    };
    expect(appJson).toMatchObject({ id: 'contracts-app', name: 'Contracts', manifestVersion: 1 });
  });
});
