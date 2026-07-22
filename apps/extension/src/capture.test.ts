import { describe, expect, it } from 'vitest';
import { anchoredCaptureText, documentCaptureTitle } from './capture.js';

describe('capture provenance', () => {
  const capture = {
    title: 'Account overview',
    url: 'https://example.test/accounts/42?tab=activity#latest',
    selection: 'First line\nSecond line',
  } as const;

  it('preserves the exact page URL in Notes and Tasks text', () => {
    expect(anchoredCaptureText(capture)).toContain(
      '[Account overview](https://example.test/accounts/42?tab=activity#latest)',
    );
  });

  it('preserves the exact page URL in a staged Docs screenshot title', () => {
    expect(documentCaptureTitle(capture)).toBe(
      'Account overview — https://example.test/accounts/42?tab=activity#latest',
    );
  });
});
