// WAL uploader pure helpers (issue #545 B7).

import { expect, test } from 'vitest';
import { discardWalFiles, walPairKey } from './wal-uploader.js';
import type { VaultPlane } from '../serve/vault-plane.js';

test('walPairKey joins vault and journal generations', () => {
  expect(walPairKey('g1', 'g2')).toBe('g1-g2');
  expect(walPairKey('abc', 'abc')).toBe('abc-abc');
});

test('discardWalFiles is a no-op when the plane has no shipper', () => {
  const plane = { walShipper: null } as unknown as VaultPlane;
  expect(discardWalFiles(plane)).toEqual({
    uploaded: 0,
    bytes: 0,
    discarded: 0,
    markerTips: {},
  });
});

test('discardWalFiles notes discarded streams before counting items', () => {
  const holed: string[] = [];
  const uploaded: Array<{ kind: string }> = [];
  const items = [
    { kind: 'segment' as const, addr: { db: 'vault' as const }, file: '/tmp/a' },
    { kind: 'closer' as const, closer: { db: 'journal' as const }, file: '/tmp/b' },
    { kind: 'pair-marker' as const, marker: {}, file: '/tmp/c' },
  ];
  const plane = {
    walShipper: {
      listUploadable: () => items,
      noteStreamDiscarded: (db: string) => holed.push(db),
      noteUploaded: (item: { kind: string }) => uploaded.push(item),
    },
  } as unknown as VaultPlane;
  const result = discardWalFiles(plane);
  expect(result).toEqual({
    uploaded: 0,
    bytes: 0,
    discarded: 3,
    markerTips: {},
  });
  // Segment → vault, closer → journal, pair-marker → both. The production
  // shipper uses a Set of dbs, so duplicates collapse before noteStreamDiscarded.
  expect([...new Set(holed)].sort()).toEqual(['journal', 'vault']);
  expect(holed).toContain('vault');
  expect(holed).toContain('journal');
  expect(uploaded.map((i) => i.kind)).toEqual(['segment', 'closer', 'pair-marker']);
});
