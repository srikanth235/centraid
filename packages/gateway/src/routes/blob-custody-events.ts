import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BlobTransferCoordinator } from '@centraid/vault';

/** Blob-scoped custody stream: no all-vault backlog/status disclosure. */
export async function openBlobCustodyEvents(input: {
  req: IncomingMessage;
  res: ServerResponse;
  transfers: BlobTransferCoordinator;
  sha256: string;
  casAck: 'receipt' | 'replicated';
}): Promise<void> {
  const { req, res, transfers, sha256, casAck } = input;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  let closed = false;
  let publishing = false;
  let again = false;
  let last = '';
  const publish = async (): Promise<void> => {
    if (closed) return;
    if (publishing) {
      again = true;
      return;
    }
    publishing = true;
    try {
      do {
        again = false;
        const state = await transfers.preflight(sha256);
        const data = JSON.stringify({
          sha256,
          exists: state.exists,
          custody: state.custody,
          casAck,
        });
        if (data !== last && !closed) {
          last = data;
          res.write(`event: custody\ndata: ${data}\n\n`);
        }
      } while (again && !closed);
    } finally {
      publishing = false;
    }
  };
  const unsubscribe = transfers.subscribe(() => void publish());
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  heartbeat.unref();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.once('close', close);
  res.once('close', close);
  await publish();
}
