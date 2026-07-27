import { beforeEach, expect, test, vi } from 'vitest';
import { pickRecoveryKit, shareRecoveryKit } from './recovery-kit-files';

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  pick: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
}));

vi.mock('expo-document-picker', () => ({ getDocumentAsync: fixture.pick }));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: fixture.available,
  shareAsync: fixture.share,
}));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'cache://' },
  File: class {
    readonly uri: string;
    constructor(baseOrUri: string, name?: string) {
      this.uri = name === undefined ? baseOrUri : `${baseOrUri}${name}`;
    }
    write(value: string): void {
      fixture.files.set(this.uri, value);
    }
    async text(): Promise<string> {
      const value = fixture.files.get(this.uri);
      if (value === undefined) throw new Error(`missing fixture ${this.uri}`);
      return value;
    }
  },
}));

beforeEach(() => {
  fixture.files.clear();
  vi.clearAllMocks();
  fixture.available.mockResolvedValue(true);
  fixture.share.mockResolvedValue(undefined);
});

test('iOS ceremony shares the wrapped file then re-reads an OS-selected copy', async () => {
  const kit = { wrapped: 'ciphertext', fingerprint: 'kit-fingerprint' };
  await shareRecoveryKit(kit);
  expect(fixture.share).toHaveBeenCalledWith('cache://centraid-recovery-kit.json', {
    mimeType: 'application/json',
  });

  const selectedUri = 'file:///private/var/mobile/Library/Mobile Documents/kit.json';
  fixture.files.set(selectedUri, JSON.stringify(kit));
  fixture.pick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: selectedUri }],
  });
  await expect(pickRecoveryKit()).resolves.toEqual(kit);
  expect(fixture.pick).toHaveBeenCalledWith({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
});

test('share refuses when the platform share sheet is unavailable', async () => {
  fixture.available.mockResolvedValue(false);
  await expect(shareRecoveryKit({ wrapped: true })).rejects.toThrow(/share sheet is unavailable/i);
  expect(fixture.share).not.toHaveBeenCalled();
});
