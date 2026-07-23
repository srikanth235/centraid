import { expect, test } from 'vitest';
import { createDeepLinkBuffer, isOAuthFinishDeepLink } from './oauth-deep-link.js';

const state = `d.${'A'.repeat(43)}`;
const receipt = `v1.1999999999.${'B'.repeat(43)}`;

test('accepts only bounded desktop OAuth finish couriers', () => {
  expect(
    isOAuthFinishDeepLink(
      `centraid://oauth/finish#${new URLSearchParams({
        code: 'google-code',
        state,
        receipt,
      })}`,
    ),
  ).toBe(true);
  expect(
    isOAuthFinishDeepLink(
      `centraid://oauth/finish#${new URLSearchParams({ error: 'access_denied', state })}`,
    ),
  ).toBe(true);
});

test('rejects other routes, web states, query material, extra fields, and oversized input', () => {
  expect(isOAuthFinishDeepLink('centraid://settings')).toBe(false);
  expect(isOAuthFinishDeepLink(`centraid://oauth/finish?code=x#state=${state}`)).toBe(false);
  expect(
    isOAuthFinishDeepLink(
      `centraid://oauth/finish#${new URLSearchParams({
        code: 'google-code',
        state: `w.${'A'.repeat(43)}`,
        receipt,
      })}`,
    ),
  ).toBe(false);
  expect(
    isOAuthFinishDeepLink(
      `centraid://oauth/finish#${new URLSearchParams({
        code: 'google-code',
        state,
        receipt,
        surprise: 'field',
      })}`,
    ),
  ).toBe(false);
  expect(isOAuthFinishDeepLink(`centraid://oauth/finish#${'x'.repeat(7_001)}`)).toBe(false);
});

test('buffers warm handoffs until the renderer subscribes, then stays in-memory live', () => {
  const buffer = createDeepLinkBuffer(2);
  const received: string[] = [];
  buffer.push('first');
  buffer.push('second');
  buffer.push('bounded-away');
  const unsubscribe = buffer.subscribe((url) => received.push(url));
  expect(received).toEqual(['first', 'second']);

  buffer.push('live');
  expect(received).toEqual(['first', 'second', 'live']);
  unsubscribe();
  buffer.push('after-unsubscribe');

  const replacement: string[] = [];
  buffer.subscribe((url) => replacement.push(url));
  expect(replacement).toEqual(['after-unsubscribe']);
});
