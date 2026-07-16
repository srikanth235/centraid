import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertSha, type BlobTransferCoordinator } from '@centraid/vault';

/** Blob-scoped custody stream: no all-vault backlog/status disclosure. */
export async function openBlobCustodyEvents(input: {
  req: IncomingMessage;
  res: ServerResponse;
  transfers: BlobTransferCoordinator;
  sha256: string;
  casAck: 'receipt' | 'replicated';
}): Promise<void> {
  const { req, res, transfers, casAck } = input;
  const sha256 = assertSha(input.sha256);
  // Validate and obtain the first snapshot before committing SSE headers so a
  // bad request or provider failure can still use the route's JSON error path.
  let firstState: Awaited<ReturnType<BlobTransferCoordinator['preflight']>> | undefined =
    await transfers.preflight(sha256);
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
  let unsubscribe = (): void => undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };
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
        const state = firstState ?? (await transfers.preflight(sha256));
        firstState = undefined;
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
  const safePublish = (): void => {
    void publish().catch(() => {
      close();
      if (!res.writableEnded) res.end();
    });
  };
  unsubscribe = transfers.subscribe(safePublish);
  heartbeat = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  heartbeat.unref();
  req.once('close', close);
  res.once('close', close);
  await publish();
}
