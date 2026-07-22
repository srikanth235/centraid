import { expect, test } from 'vitest';
import {
  decideCors,
  hasBearerAuthIntent,
  hostnameFromHostHeader,
  isAllowedHostHeader,
} from './request-boundary.ts';

test('hostnameFromHostHeader strips ports and normalizes IPv6 brackets', () => {
  expect(hostnameFromHostHeader('127.0.0.1:8787')).toBe('127.0.0.1');
  expect(hostnameFromHostHeader('localhost')).toBe('localhost');
  expect(hostnameFromHostHeader('[::1]:3000')).toBe('[::1]');
  expect(hostnameFromHostHeader(undefined)).toBeUndefined();
  expect(hostnameFromHostHeader('')).toBeUndefined();
});

test('isAllowedHostHeader accepts loopback and configured names only', () => {
  expect(isAllowedHostHeader('127.0.0.1:1')).toBe(true);
  expect(isAllowedHostHeader('localhost:9')).toBe(true);
  expect(isAllowedHostHeader('[::1]')).toBe(true);
  expect(isAllowedHostHeader('evil.example')).toBe(false);
  expect(isAllowedHostHeader('gateway.local:80', ['gateway.local'])).toBe(true);
  expect(isAllowedHostHeader(undefined)).toBe(false);
});

test('decideCors never pairs foreign Origin with credentials without Bearer intent', () => {
  const foreign = decideCors({
    origin: 'http://attacker:9',
    credentialedOrigins: ['http://shell:1'],
    bearerAuthIntent: false,
  });
  expect(foreign).toEqual({ allowOrigin: '*', credentials: false });

  const shell = decideCors({
    origin: 'http://shell:1',
    credentialedOrigins: ['http://shell:1'],
    bearerAuthIntent: false,
  });
  expect(shell).toEqual({ allowOrigin: 'http://shell:1', credentials: true });

  const bearer = decideCors({
    origin: 'http://attacker:9',
    credentialedOrigins: [],
    bearerAuthIntent: true,
  });
  expect(bearer).toEqual({ allowOrigin: 'http://attacker:9', credentials: true });

  expect(decideCors({ origin: 'null', credentialedOrigins: [], bearerAuthIntent: false })).toEqual({
    allowOrigin: '*',
    credentials: false,
  });
});

test('hasBearerAuthIntent reads Authorization and preflight ACRH', () => {
  expect(hasBearerAuthIntent('Bearer abc', undefined)).toBe(true);
  expect(hasBearerAuthIntent(undefined, 'authorization, content-type')).toBe(true);
  expect(hasBearerAuthIntent(undefined, 'content-type')).toBe(false);
  expect(hasBearerAuthIntent(undefined, undefined)).toBe(false);
});
