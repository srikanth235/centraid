import crypto from 'node:crypto';
import path from 'node:path';

export interface DataPlaneHttpOptions {
  baseUrl: string;
  secret: string;
  rootDir: string;
}

interface BlobTicket {
  relativePath: string;
  expiresAtMs: number;
  nonce: string;
  mediaType: string;
  disposition: string;
  etag: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function createBlobHandoffUrl(
  options: DataPlaneHttpOptions,
  input: {
    file: string;
    mediaType: string;
    disposition: string;
    etag: string;
    nowMs?: number;
  },
): string | undefined {
  const relativePath = path.relative(path.resolve(options.rootDir), path.resolve(input.file));
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const ticket: BlobTicket = {
    relativePath,
    expiresAtMs: (input.nowMs ?? Date.now()) + 10_000,
    nonce: crypto.randomBytes(16).toString('hex'),
    mediaType: input.mediaType,
    disposition: input.disposition,
    etag: input.etag,
  };
  const payload = base64url(Buffer.from(JSON.stringify(ticket)));
  const signature = base64url(crypto.createHmac('sha256', options.secret).update(payload).digest());
  const target = new URL('/v1/blob', options.baseUrl);
  target.searchParams.set('ticket', `${payload}.${signature}`);
  return target.toString();
}
