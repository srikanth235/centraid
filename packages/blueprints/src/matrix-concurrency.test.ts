/**
 * Matrix cell blueprints.concurrency (#535 coverable-today).
 * Scaffold builders are pure — concurrent builds must not share arrays/maps.
 */
import { describe, expect, it } from 'vitest';
import { scaffoldAppFiles } from './scaffold-files.js';

describe('blueprint scaffold concurrency', () => {
  it('parallel scaffoldAppFiles calls return independent file maps', () => {
    const maps = Array.from({ length: 24 }, (_, i) =>
      scaffoldAppFiles(`app-${i}`, { name: `App ${i}` }),
    );
    expect(maps).toHaveLength(24);
    for (let i = 0; i < maps.length; i += 1) {
      const appJson = JSON.parse(maps[i]!.find((f) => f.path === 'app.json')!.content) as {
        id: string;
        name: string;
      };
      expect(appJson.id).toBe(`app-${i}`);
      expect(appJson.name).toBe(`App ${i}`);
    }
    // Mutate one map only; siblings stay intact.
    maps[0]![0]!.content = 'MUTATED';
    for (let i = 1; i < maps.length; i += 1) {
      expect(maps[i]![0]!.content).not.toBe('MUTATED');
      const appJson = JSON.parse(maps[i]!.find((f) => f.path === 'app.json')!.content) as {
        id: string;
      };
      expect(appJson.id).toBe(`app-${i}`);
    }
  });
});
