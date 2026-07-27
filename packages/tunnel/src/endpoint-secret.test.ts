import { expect, test, vi } from 'vitest';
import {
  EndpointSecretError,
  loadEndpointSecret,
  type EndpointSecretPersistence,
} from './endpoint-secret.js';

function memory(initial: Uint8Array | null): EndpointSecretPersistence & {
  current: Uint8Array | null;
} {
  return {
    current: initial,
    load() {
      return this.current;
    },
    store(secret) {
      this.current = Uint8Array.from(secret);
    },
  };
}

test('returns a stable existing identity and mints only when absent', () => {
  const existing = memory(Uint8Array.from({ length: 32 }, (_, i) => i));
  const first = loadEndpointSecret({
    persistence: existing,
    onCorrupt: 'refuse',
    label: 'endpoint key',
  });
  expect(first).toEqual(existing.current);

  const empty = memory(null);
  const minted = loadEndpointSecret({
    persistence: empty,
    onCorrupt: 'refuse',
    label: 'endpoint key',
  });
  expect(minted).toHaveLength(32);
  expect(empty.current).toEqual(minted);
});

test('gateway corruption refuses with both recovery choices', () => {
  expect(() =>
    loadEndpointSecret({
      persistence: memory(new Uint8Array(7)),
      onCorrupt: 'refuse',
      label: 'endpoint key',
    }),
  ).toThrow(EndpointSecretError);
  try {
    loadEndpointSecret({
      persistence: memory(new Uint8Array(7)),
      onCorrupt: 'refuse',
      label: 'endpoint key',
    });
  } catch (error) {
    expect(String(error)).toContain('Restore');
    expect(String(error)).toContain('remove it deliberately');
  }
});

test('device corruption remints and warns', () => {
  const persistence = memory(new Uint8Array(3));
  const warn = vi.fn();
  const secret = loadEndpointSecret({
    persistence,
    onCorrupt: 'remint',
    label: 'device key',
    warn,
  });
  expect(secret).toHaveLength(32);
  expect(persistence.current).toEqual(secret);
  expect(warn).toHaveBeenCalledOnce();
});
