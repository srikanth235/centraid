// Tokenless, loopback-only host for the nightly iOS Simulator journeys.
// It mounts the real host-agnostic gateway graph directly, so the phone can
// exercise clone/publish/list/static-serve without a bearer that WebView cannot
// attach in manual-URL development mode.

import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { buildGateway } from '../../../packages/gateway/dist/serve/build-gateway.js';

const dataDir = path.resolve(process.argv[2] ?? 'artifacts/mobile-ci-gateway');
const port = Number(process.argv[3] ?? 18_789);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`invalid mobile CI gateway port: ${process.argv[3]}`);
}

await mkdir(dataDir, { recursive: true });
const gateway = await buildGateway({
  paths: {
    vaultDir: path.join(dataDir, 'vault'),
    prefsFile: path.join(dataDir, 'prefs.json'),
  },
});
await gateway.start(`http://127.0.0.1:${port}`);

const server = http.createServer((request, response) => {
  void gateway
    .composedHandler(request, response)
    .then((handled) => {
      if (handled || response.headersSent) return;
      response.statusCode = 404;
      response.end('not found');
    })
    .catch((error) => {
      if (response.headersSent) return response.destroy(error);
      response.statusCode = 500;
      response.end('gateway error');
    });
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
console.log(`mobile CI gateway listening on http://127.0.0.1:${port}`);

async function close() {
  await new Promise((resolve) => server.close(resolve));
  await gateway.stop();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
