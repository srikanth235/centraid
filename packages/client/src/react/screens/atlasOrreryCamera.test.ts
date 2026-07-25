/**
 * Names atlasOrreryCamera.ts (issue #545 B8). Pure pan/zoom math lives in
 * atlasOrreryGeometry (already tested); this pins the hook export for
 * cold-import reachability under the client suite.
 */

import { describe, expect, it } from 'vitest';
import { useOrreryCamera } from './atlasOrreryCamera.js';

describe('useOrreryCamera module', () => {
  it('exports a React hook function', () => {
    expect(typeof useOrreryCamera).toBe('function');
    expect(useOrreryCamera.name).toBe('useOrreryCamera');
  });
});
