import { describe, expect, it } from 'vitest';
import { fingerprintOf, UpdatePoller } from './update-check.js';

const fp = (n: number): string => fingerprintOf([{ mtimeMs: n, size: 100 }, null]);

describe('fingerprintOf', () => {
  it('is order-sensitive and marks missing files', () => {
    expect(fingerprintOf([{ mtimeMs: 1, size: 2 }, null])).toBe('1:2|absent');
    expect(fingerprintOf([null, { mtimeMs: 1, size: 2 }])).toBe('absent|1:2');
  });

  it('changes when any mtime or size changes', () => {
    const base = fingerprintOf([{ mtimeMs: 1, size: 2 }]);
    expect(fingerprintOf([{ mtimeMs: 3, size: 2 }])).not.toBe(base);
    expect(fingerprintOf([{ mtimeMs: 1, size: 5 }])).not.toBe(base);
  });
});

describe('UpdatePoller', () => {
  it('stays unchanged while the disk matches the launch baseline', () => {
    const poller = new UpdatePoller(fp(1));
    expect(poller.tick(fp(1))).toBe('unchanged');
    expect(poller.tick(fp(1))).toBe('unchanged');
    expect(poller.available).toBe(false);
  });

  it('announces once a changed fingerprint holds for two consecutive ticks', () => {
    const poller = new UpdatePoller(fp(1));
    expect(poller.tick(fp(2))).toBe('settling'); // build just wrote
    expect(poller.tick(fp(2))).toBe('update-available'); // settled
    expect(poller.available).toBe(true);
  });

  it('keeps waiting while a build is still writing files', () => {
    const poller = new UpdatePoller(fp(1));
    expect(poller.tick(fp(2))).toBe('settling'); // tsc output landed
    expect(poller.tick(fp(3))).toBe('settling'); // vite output landed
    expect(poller.tick(fp(3))).toBe('update-available');
  });

  it('announces exactly once — later rebuilds do not re-fire', () => {
    const poller = new UpdatePoller(fp(1));
    poller.tick(fp(2));
    expect(poller.tick(fp(2))).toBe('update-available');
    expect(poller.tick(fp(4))).toBe('settling'); // another rebuild
    expect(poller.tick(fp(4))).toBe('unchanged'); // no second announcement
    expect(poller.available).toBe(true);
  });
});
