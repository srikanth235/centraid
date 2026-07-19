import { describe, expect, it } from 'vitest';
import vectors from '../spec/origin-matching-v1.json';
import { matchesOrigin } from './origin-matching.js';

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
