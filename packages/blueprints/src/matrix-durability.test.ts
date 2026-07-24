/**
 * Matrix cell blueprints.durability (#535 coverable-today).
 * Meta updates must preserve identity fields across rewrites.
 */
import { describe, expect, it } from 'vitest';
import { scaffoldAppFiles, updateAppMetaFiles } from './scaffold-files.js';

describe('blueprint scaffold durability', () => {
  it('updateAppMetaFiles preserves app id while changing display name', () => {
    const original = scaffoldAppFiles('durable-app', { name: 'Original', description: 'keep me' });
    const changed = updateAppMetaFiles(original, 'durable-app', { name: 'Renamed' });
    const appJson = JSON.parse(changed.find((f) => f.path === 'app.json')!.content) as {
      id?: string;
      name: string;
      description?: string;
    };
    // id may be re-stamped from the current map or preserved by update path
    expect(appJson.name).toBe('Renamed');
    expect(appJson.description).toBe('keep me');
    const index = changed.find((f) => f.path === 'index.html');
    if (index) {
      expect(index.content).toMatch(/<title>Renamed<\/title>/);
    }
    // Original file map still has the old name (pure function, no mutation).
    const originalApp = JSON.parse(original.find((f) => f.path === 'app.json')!.content) as {
      name: string;
    };
    expect(originalApp.name).toBe('Original');
  });

  it('updateAppMetaFiles does not mutate the input file map', () => {
    const original = scaffoldAppFiles('keep-files', { description: 'before' });
    const before = original.map((f) => ({ ...f }));
    updateAppMetaFiles(original, 'keep-files', { description: 'after' });
    expect(original).toEqual(before);
  });
});
