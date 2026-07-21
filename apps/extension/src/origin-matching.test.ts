import { describe, expect, it } from 'vitest';
import vectors from '../spec/origin-matching-v1.json';
import { isEligiblePageUrl, isLoopback, matchesOrigin } from './origin-matching.js';

describe('Locker origin matching v1', () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      expect(
        matchesOrigin(
          {
            url: vector.stored,
            url_match_policy: vector.policy as 'exact-host' | 'registrable-domain',
          },
          vector.page,
        ),
      ).toBe(vector.match);
    });
  }
});

describe('isLoopback', () => {
  it('accepts true IPv4 127.0.0.0/8 and localhost names', () => {
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('[::1]')).toBe(true);
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.255.255.255')).toBe(true);
  });

  it('rejects hostnames that only look like loopback', () => {
    expect(isLoopback('127.0.0.1.evil.test')).toBe(false);
    expect(isLoopback('127.foo.bar')).toBe(false);
    expect(isLoopback('127.0.0.1.nip.io')).toBe(false);
    expect(isLoopback('128.0.0.1')).toBe(false);
    expect(isLoopback('example.com')).toBe(false);
  });

  it('marks evil 127 hostnames ineligible for HTTP pages', () => {
    expect(isEligiblePageUrl('http://127.0.0.1.evil.test')).toBe(false);
    expect(isEligiblePageUrl('http://127.0.0.1')).toBe(true);
    expect(isEligiblePageUrl('https://127.0.0.1.evil.test')).toBe(true);
  });
});
