import { expect, test } from 'vitest';
import {
  assertDirectUrlAllowed,
  isPrivateHost,
  resolveTransport,
  TransportGuardError,
} from './transport.ts';

test('resolveTransport: explicit wins, else derived from kind + endpointId', () => {
  expect(resolveTransport({ kind: 'local' })).toBe('local');
  expect(resolveTransport({ kind: 'remote', url: 'https://x' })).toBe('direct');
  expect(resolveTransport({ kind: 'remote', endpointId: 'ep-abc' })).toBe('iroh');
  // Explicit overrides derivation.
  expect(resolveTransport({ kind: 'remote', transport: 'iroh', url: 'https://x' })).toBe('iroh');
});

test('isPrivateHost: loopback / RFC1918 / link-local / LAN are private', () => {
  for (const h of [
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.9',
    '172.16.0.1',
    '172.31.255.1',
    '169.254.1.1',
    '::1',
    'fd00::1',
    'fe80::1',
    'my-box.local',
  ]) {
    expect(isPrivateHost(h), h).toBe(true);
  }
});

test('isPrivateHost: public hosts are not private', () => {
  for (const h of ['8.8.8.8', '172.32.0.1', 'gateway.example.com', '2001:db8::1']) {
    expect(isPrivateHost(h), h).toBe(false);
  }
});

test('assertDirectUrlAllowed: https always ok; plain http only to private hosts', () => {
  expect(() => assertDirectUrlAllowed('https://gateway.example.com')).not.toThrow();
  expect(() => assertDirectUrlAllowed('http://127.0.0.1:8765')).not.toThrow();
  expect(() => assertDirectUrlAllowed('http://192.168.1.5:8765')).not.toThrow();
  // The guardrail: cleartext bearer to a public host is refused.
  expect(() => assertDirectUrlAllowed('http://gateway.example.com')).toThrow(TransportGuardError);
  expect(() => assertDirectUrlAllowed('http://8.8.8.8')).toThrow(TransportGuardError);
  // Malformed + non-http(s) schemes are rejected.
  expect(() => assertDirectUrlAllowed('not a url')).toThrow(TransportGuardError);
  expect(() => assertDirectUrlAllowed('ftp://host/x')).toThrow(TransportGuardError);
});
