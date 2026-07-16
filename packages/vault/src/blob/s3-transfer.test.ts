import { expect, test } from 'vitest';
import { S3TransferStore } from './s3-transfer.js';

const CREDS = () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' });

test('temporary multipart enumeration paginates inside the vault prefix and can abort results', async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    urls.push(url);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const marker = url.searchParams.get('key-marker');
    if (!marker) {
      return new Response(
        `<ListMultipartUploadsResult>
          <IsTruncated>true</IsTruncated>
          <NextKeyMarker>vault%2Fone%2Ftmp%2Fblobs%2Ftemp-a</NextKeyMarker>
          <NextUploadIdMarker>upload&amp;one</NextUploadIdMarker>
          <Upload>
            <Key>vault%2Fone%2Ftmp%2Fblobs%2Ftemp-a</Key>
            <UploadId>upload&amp;one</UploadId>
            <Initiated>2026-07-01T00:00:00.000Z</Initiated>
          </Upload>
        </ListMultipartUploadsResult>`,
        { status: 200 },
      );
    }
    expect(marker).toBe('vault/one/tmp/blobs/temp-a');
    expect(url.searchParams.get('upload-id-marker')).toBe('upload&one');
    return new Response(
      `<ListMultipartUploadsResult>
        <IsTruncated>false</IsTruncated>
        <Upload>
          <Key>vault%2Fone%2Ftmp%2Fblobs%2Ftemp-b</Key>
          <UploadId>upload-two</UploadId>
          <Initiated>2026-07-02T00:00:00.000Z</Initiated>
        </Upload>
        <Upload>
          <Key>some-other-prefix%2Fignored</Key>
          <UploadId>ignored</UploadId>
          <Initiated>2020-01-01T00:00:00.000Z</Initiated>
        </Upload>
      </ListMultipartUploadsResult>`,
      { status: 200 },
    );
  };
  const transfer = new S3TransferStore({
    endpoint: 'https://s3.example.test',
    bucket: 'test-bucket',
    prefix: 'vault/one',
    credentials: CREDS,
    fetchImpl,
  });

  const uploads = await transfer.listTemporaryUploads();
  expect(uploads).toEqual([
    {
      tempId: 'temp-a',
      uploadId: 'upload&one',
      initiatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      tempId: 'temp-b',
      uploadId: 'upload-two',
      initiatedAt: '2026-07-02T00:00:00.000Z',
    },
  ]);
  expect(urls[0]?.pathname).toBe('/test-bucket');
  expect(urls[0]?.searchParams.get('prefix')).toBe('vault/one/tmp/blobs/');

  await transfer.abortTemporaryUpload(uploads[0]!.tempId, uploads[0]!.uploadId);
  expect(urls.at(-1)?.pathname).toBe('/test-bucket/vault/one/tmp/blobs/temp-a');
  expect(urls.at(-1)?.searchParams.get('uploadId')).toBe('upload&one');
});

test('final-SHA multipart writes every operation against the content-addressed key', async () => {
  const calls: { method: string; url: URL; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const bytes = init?.body
      ? Buffer.from(await new Response(init.body).arrayBuffer())
      : Buffer.alloc(0);
    calls.push({ method: init?.method ?? 'GET', url, body: bytes.toString() });
    if (init?.method === 'POST' && url.searchParams.has('uploads')) {
      return new Response(
        '<InitiateMultipartUploadResult><UploadId>final-upload</UploadId></InitiateMultipartUploadResult>',
      );
    }
    if (init?.method === 'PUT')
      return new Response(null, { status: 200, headers: { etag: '"p1"' } });
    if (init?.method === 'POST') return new Response(null, { status: 200 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  };
  const transfer = new S3TransferStore({
    endpoint: 'https://s3.example.test',
    bucket: 'test-bucket',
    prefix: 'vault/one',
    credentials: CREDS,
    fetchImpl,
  });
  const sha = 'a'.repeat(64);
  const uploadId = await transfer.beginShaUpload(sha);
  const etag = await transfer.uploadShaPart(sha, uploadId, 1, Buffer.from('sealed'));
  await transfer.completeShaUpload(sha, uploadId, [{ partNumber: 1, etag }]);

  expect(uploadId).toBe('final-upload');
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.url.pathname).toBe(`/test-bucket/vault/one/blobs/sha256/${sha}`);
    expect(call.url.pathname).not.toContain('/tmp/');
  }
  expect(calls[1]?.url.searchParams.get('partNumber')).toBe('1');
  expect(calls[2]?.body).toContain('<PartNumber>1</PartNumber>');
});
