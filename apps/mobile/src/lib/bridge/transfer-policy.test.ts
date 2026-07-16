import { describe, expect, test, vi } from 'vitest';
import { assertGatewayMintedUploadUrl } from './transfer-policy';

const scope = {
  gatewayBaseUrl: 'http://127.0.0.1:18789',
  fetchImpl: vi.fn(async () =>
    Response.json({
      blob_store: {
        kind: 's3',
        endpoint: 'https://provider.example',
        bucket: 'vault-cas',
        prefix: 'owners/one',
      },
    }),
  ),
};

describe('native background transfer policy', () => {
  test('accepts only gateway-presigned temporary objects on the configured provider', async () => {
    const accepted = await assertGatewayMintedUploadUrl(
      'https://provider.example/vault-cas/owners/one/tmp/blobs/direct-one' +
        '?partNumber=1&X-Amz-Expires=600&X-Amz-Signature=abc',
      scope,
    );
    expect(accepted.hostname).toBe('provider.example');
  });

  test('rejects arbitrary app-selected HTTPS destinations and non-transfer paths', async () => {
    await expect(
      assertGatewayMintedUploadUrl(
        'https://evil.example/collect?X-Amz-Expires=600&X-Amz-Signature=abc',
        scope,
      ),
    ).rejects.toThrow('not the active provider');
    await expect(
      assertGatewayMintedUploadUrl(
        'https://provider.example/vault-cas/owners/one/blobs/sha256/secret' +
          '?X-Amz-Expires=600&X-Amz-Signature=abc',
        scope,
      ),
    ).rejects.toThrow('outside blob transfer scope');
  });
});
