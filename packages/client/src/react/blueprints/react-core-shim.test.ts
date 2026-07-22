import { describe, expect, it } from 'vitest';
import { useState as reactUseState } from 'react';
import { createRoot as reactDomCreateRoot } from 'react-dom/client';
import * as shim from './react-core-shim.js';

// The whole point of the shim is that inline blueprint apps share the shell's
// ONE React runtime — otherwise hooks throw. Reference identity is the proof.
// (`useState` rides the runtime-only `export *`, which is invisible to tsc — see
// the shim's `@ts-expect-error` (#505) — so it is read through a cast here.)
describe('react-core-shim', () => {
  it('re-exports the shell React hooks by identity', () => {
    const shimUseState = (shim as unknown as { useState: unknown }).useState;
    expect(shimUseState).toBe(reactUseState);
  });

  it('re-exports react-dom/client createRoot by identity', () => {
    expect(shim.createRoot).toBe(reactDomCreateRoot);
  });
});
