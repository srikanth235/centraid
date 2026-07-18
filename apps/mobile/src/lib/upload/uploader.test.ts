import { tempDirSync } from '@centraid/test-kit/temp-dir';
// Drainer behaviour: the URL gate, dedupe, resume reconciliation, retry
// classification, and the network-policy seam.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frameCountFor, partCountFor, sealedSizeFor } from './cbsf';
import { webCryptoUploadCrypto } from './crypto';
import { DirectTransferError, type DirectTransferClient } from './gateway-client';
import {
  FAKE_GATEWAY,
  FakeGateway,
  FakeProvider,
  Killer,
  fakeBlobStoreFetch,
} from './fake-direct-transfer';
import { bytesFileSource } from './file-source';
import { NodeSqliteFileDriver } from './node-sqlite-driver';
import { UploadQueueStore } from './store';
import { UploadDrainer, type PartPutter } from './uploader';

const crypto = webCryptoUploadCrypto();
const fetchImpl = fakeBlobStoreFetch();
const BYTES = new Uint8Array(2_048).map((_, index) => index & 0xff);
const SHA = 'd'.repeat(64);

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;
let killer: Killer;
let provider: FakeProvider;
let gateway: FakeGateway;

const openFile = async () => bytesFileSource(BYTES);

function enqueue(sha = SHA): void {
  const frameCount = frameCountFor(BYTES.byteLength);
  store.enqueue({
    itemId: `item-${sha.slice(0, 4)}`,
    sha256: sha,
    localUri: 'file://a.jpg',
    plaintextSize: BYTES.byteLength,
    sealedSize: sealedSizeFor(BYTES.byteLength, frameCount),
    frameCount,
    partCount: partCountFor(frameCount),
  });
}

function drainer(
  overrides: Partial<{
    putPart: PartPutter;
    client: DirectTransferClient;
    policy: { canTransfer(): boolean };
  }> = {},
): UploadDrainer {
  return new UploadDrainer({
    store,
    client: overrides.client ?? gateway,
    crypto,
    openFile,
    putPart: overrides.putPart ?? (({ url, body }) => provider.put(url, body)),
    gatewayBaseUrl: FAKE_GATEWAY,
    fetchImpl,
    partConcurrency: 1,
    ...(overrides.policy ? { policy: overrides.policy } : {}),
  });
}

beforeEach(() => {
  dir = tempDirSync('centraid-drain-');
  driver = new NodeSqliteFileDriver(join(dir, 'uploads.db'));
  store = UploadQueueStore.create(driver);
  killer = new Killer();
  provider = new FakeProvider(killer);
  gateway = new FakeGateway(provider, killer);
});

afterEach(() => {
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('UploadDrainer', () => {
  it('settles an item and persists the casAck receipt', async () => {
    enqueue();
    const summary = await drainer().drainOnce();
    expect(summary).toMatchObject({ settled: 1, failed: 0, halted: false });
    const item = store.bySha(SHA)!;
    expect(item.state).toBe('settled');
    expect(item.receipt).toMatchObject({ casAck: 'replicated', custody: 'remote-only' });
  });

  describe('the URL gate', () => {
    it('refuses to PUT to a URL the gateway did not mint', async () => {
      enqueue();
      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      // A gateway that hands back an attacker-controlled destination.
      const evil: DirectTransferClient = {
        begin: async (input) => ({
          ...(await gateway.begin(input)),
          sessionId: 'session-evil',
          upload: {
            kind: 'multipart',
            uploadId: 'u1',
            parts: [
              {
                partNumber: 1,
                url: 'https://evil.example.test/centraid-blobs/vault1/tmp/blobs/x?X-Amz-Signature=a&X-Amz-Expires=900',
              },
            ],
          },
        }),
        recordPart: async () => undefined,
        complete: async () => ({}),
      };

      await drainer({ client: evil, putPart }).drainOnce();

      expect(putPart, 'no bytes may leave before the URL is pinned').not.toHaveBeenCalled();
      expect(store.bySha(SHA)?.lastError).toMatch(/not the active provider/);
    });

    it.each([
      ['off-origin', 'https://evil.example.test/centraid-blobs/vault1/tmp/blobs/x'],
      ['outside the blob scope', 'https://s3.example.test/centraid-blobs/vault1/other/x'],
      ['wrong bucket', 'https://s3.example.test/other-bucket/vault1/tmp/blobs/x'],
      ['unsigned', 'https://s3.example.test/centraid-blobs/vault1/tmp/blobs/x?X-Amz-Expires=900'],
    ])('rejects a %s URL before any PUT', async (_label, href) => {
      enqueue();
      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      const evil: DirectTransferClient = {
        begin: async (input) => ({
          ...(await gateway.begin(input)),
          sessionId: 'session-evil',
          upload: {
            kind: 'multipart',
            uploadId: 'u1',
            parts: [{ partNumber: 1, url: `${href}?X-Amz-Signature=a&X-Amz-Expires=900` }],
          },
        }),
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      await drainer({ client: evil, putPart }).drainOnce();
      expect(putPart).not.toHaveBeenCalled();
    });
  });

  it('transfers nothing when the gateway reports the blob is already present', async () => {
    enqueue();
    await drainer().drainOnce();

    // A second item for the same sha, forced past the store's own dedupe.
    driver.run(`UPDATE upload_item SET state = 'pending', receipt_json = NULL WHERE sha256 = ?`, [
      SHA,
    ]);
    const putPart = vi.fn<PartPutter>(async () => '"etag"');
    const summary = await drainer({ putPart }).drainOnce();

    expect(summary.deduped).toBe(1);
    expect(putPart, 'alreadyPresent must skip the transfer entirely').not.toHaveBeenCalled();
    // The receipt is the gateway's, verbatim — casAck came from the server.
    expect(store.bySha(SHA)?.receipt).toMatchObject({
      alreadyPresent: true,
      casAck: 'replicated',
      custody: 'remote-only',
    });
  });

  it('persists an unreplicated settlement verbatim instead of fabricating a casAck', async () => {
    enqueue();
    // A gateway that dedupes a blob it holds only locally: the honest receipt
    // says casAck `receipt`, which must NOT be rewritten to `replicated`.
    const localOnly: DirectTransferClient = {
      begin: async (input) => ({
        ...(await gateway.begin(input)),
        alreadyPresent: true,
        custody: 'local-only',
        sessionId: undefined,
        upload: undefined,
        settlement: {
          alreadyPresent: true,
          sha256: input.sha256,
          casAck: 'receipt',
          custody: 'local-only',
          acknowledged: false,
        },
      }),
      recordPart: async () => undefined,
      complete: async () => ({}),
    };
    const putPart = vi.fn<PartPutter>(async () => '"etag"');
    const summary = await drainer({ client: localOnly, putPart }).drainOnce();

    expect(summary.deduped).toBe(1);
    expect(putPart).not.toHaveBeenCalled();
    expect(store.bySha(SHA)?.receipt).toEqual({
      alreadyPresent: true,
      sha256: SHA,
      casAck: 'receipt',
      custody: 'local-only',
      acknowledged: false,
    });
  });

  it('reconciles gateway-completed parts into the queue and skips re-uploading them', async () => {
    enqueue();
    // The gateway already holds part 1 from a previous life.
    const item = store.bySha(SHA)!;
    const plan = await gateway.begin({
      sha256: SHA,
      plaintextSize: BYTES.byteLength,
      sealedSize: item.sealedSize,
      partCount: item.partCount,
    });
    const url = (plan.upload as { parts: { partNumber: number; url: string }[] }).parts[0]!.url;
    const etag = await provider.put(url, await sealedPartOne(item.sealedSize));
    await gateway.recordPart(plan.sessionId!, 1, etag);

    const putPart = vi.fn<PartPutter>(async () => '"etag"');
    await drainer({ putPart }).drainOnce();

    expect(
      putPart,
      'a part the gateway already has must not be re-uploaded',
    ).not.toHaveBeenCalled();
    expect(store.parts(item.itemId)[0]?.state).toBe('recorded');
  });

  it('retries a transient failure but gives up on a terminal one', async () => {
    enqueue();
    const flaky: DirectTransferClient = {
      begin: async () => {
        throw new DirectTransferError('gateway is offline', 503);
      },
      recordPart: async () => undefined,
      complete: async () => ({}),
    };
    await drainer({ client: flaky }).drainOnce();
    expect(store.bySha(SHA)?.state, '503 is retryable').toBe('pending');

    const refused: DirectTransferClient = {
      begin: async () => {
        throw new DirectTransferError('not a paired device', 403);
      },
      recordPart: async () => undefined,
      complete: async () => ({}),
    };
    await drainer({ client: refused }).drainOnce();
    expect(store.bySha(SHA)?.state, '403 will not fix itself').toBe('failed');
  });

  it('gives up after MAX_ATTEMPTS transient failures', async () => {
    enqueue();
    const flaky: DirectTransferClient = {
      begin: async () => {
        throw new DirectTransferError('offline', 503);
      },
      recordPart: async () => undefined,
      complete: async () => ({}),
    };
    for (let attempt = 0; attempt < 5; attempt += 1) await drainer({ client: flaky }).drainOnce();
    expect(store.bySha(SHA)?.state).toBe('failed');
  });

  it('halts cleanly when policy denies transfer, leaving the item recoverable', async () => {
    enqueue();
    const putPart = vi.fn<PartPutter>(async () => '"etag"');
    const summary = await drainer({ putPart, policy: { canTransfer: () => false } }).drainOnce();
    expect(summary.halted).toBe(true);
    expect(putPart).not.toHaveBeenCalled();
    expect(store.bySha(SHA)?.state).toBe('pending');
  });

  it('refuses a local file that changed under the queue', async () => {
    enqueue();
    // The sha addressed 2048 bytes; the file on disk is now something else.
    driver.run('UPDATE upload_item SET plaintext_size = 999 WHERE sha256 = ?', [SHA]);
    await drainer().drainOnce();
    expect(store.bySha(SHA)?.state).toBe('failed');
    expect(store.bySha(SHA)?.lastError).toMatch(/expected 999/);
  });
});

/** Seal part 1 the way the drainer would, for the resume fixture above. */
async function sealedPartOne(sealedSize: number): Promise<Uint8Array> {
  const { sealDirectory, sealPart } = await import('./cbsf');
  const key = gateway.keyFor(SHA);
  const frameCount = frameCountFor(BYTES.byteLength);
  const directory = await sealDirectory(crypto, key, SHA, BYTES.byteLength, frameCount);
  const body = await sealPart({
    crypto,
    key,
    sha256: SHA,
    plaintextSize: BYTES.byteLength,
    frameCount,
    partNumber: 1,
    directory,
    read: async (offset, length) => BYTES.subarray(offset, offset + length),
  });
  expect(body.byteLength).toBe(sealedSize);
  return body;
}
