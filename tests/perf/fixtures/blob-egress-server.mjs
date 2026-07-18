import http from 'node:http';
import { makeBlobRouteHandler } from '../../../packages/gateway/dist/routes/blob-routes.js';
import { openVaultPlane } from '../../../packages/gateway/dist/serve/vault-plane.js';

const directory = process.argv[2];
const contentId = process.argv[3];
const size = Number(process.argv[4]);
if (!directory || !contentId || !Number.isSafeInteger(size) || size <= 0) {
  throw new Error('blob egress fixture needs a seeded vault directory, content id, and size');
}

const plane = openVaultPlane({
  dir: directory,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  ownerName: 'Perf owner',
});
// This fresh process opens a vault seeded by its parent. It has never allocated
// the 128 MiB payload, so its baseline cannot hide a whole-file read through
// allocator reuse.
globalThis.gc?.();

const handler = makeBlobRouteHandler({ current: () => plane });
const baselineRss = process.memoryUsage().rss;
let peakRss = baselineRss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 2);
sampler.unref();

const server = http.createServer((request, response) => {
  response.once('finish', () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.send?.({
      type: 'served',
      rssGrowthBytes: Math.max(0, peakRss - baselineRss),
    });
  });
  void handler(request, response);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  process.send?.({ type: 'ready', port: address.port, contentId, size });
});

process.on('message', (message) => {
  if (message?.type !== 'close') return;
  clearInterval(sampler);
  server.close(() => {
    plane.stop();
    process.exit(0);
  });
});
