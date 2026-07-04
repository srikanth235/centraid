#!/usr/bin/env node
// Phase 0 spike for issue #263 — validate the dumbpipe architecture.
//
//   --local                     whole loop on one machine (demo gateway + desktop + phone proxy)
//   --serve [--upstream URL --token T]
//                               desktop role; without --upstream, serves a demo app.
//                               Prints the pair payload to give to --dial.
//   --dial '<pair payload>'     phone role; pairs, then serves http://127.0.0.1:8787
//
// Build first: bun run --filter=@centraid/tunnel build
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createTunnelClient,
  DeviceStore,
  parsePairQrPayload,
  startDesktopTunnel,
  startLocalProxy,
} from '../dist/index.js';

// Spike CLI: stdout IS the interface (pair payloads, verdicts).
const log = (...parts) => process.stdout.write(`${parts.map(String).join(' ')}\n`);

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? '') : undefined;
};

const DEMO_TOKEN = 'spike-token';

function startDemoGateway() {
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${DEMO_TOKEN}`) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('import "./kit.js";');
      return;
    }
    if (req.url === '/kit.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('document.body.append(" — ES module chain loaded through the tunnel ✔");');
      return;
    }
    if (req.url === '/changes') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => res.write(`data: tick ${++n}\n\n`), 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html><body>hello from the desktop<script type="module" src="app.js"></script></body></html>',
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function serve() {
  let upstream;
  const upstreamUrl = flag('--upstream');
  if (upstreamUrl) {
    const token = flag('--token') ?? '';
    upstream = () => ({ baseUrl: upstreamUrl, token });
  } else {
    const server = await startDemoGateway();
    const { port } = server.address();
    log(`[serve] demo gateway on 127.0.0.1:${port}`);
    upstream = () => ({ baseUrl: `http://127.0.0.1:${port}`, token: DEMO_TOKEN });
  }
  const store = DeviceStore.open(path.join(os.tmpdir(), 'centraid-spike-devices.json'));
  const desktop = await startDesktopTunnel({
    upstream,
    deviceStore: store,
    desktopName: 'Spike Desktop',
    onPaired: (device) =>
      log(`[serve] paired: ${device.name} (${device.endpointId.slice(0, 10)}…)`),
  });
  const pairing = desktop.beginPairing(30 * 60 * 1000);
  log(`[serve] endpoint ${desktop.endpointId}`);
  log('[serve] pair payload (give to --dial):');
  log(pairing.qrPayload);
  return desktop;
}

async function dial(payloadRaw) {
  const payload = parsePairQrPayload(payloadRaw);
  if (!payload) throw new Error('not a centraid pair payload');
  const client = await createTunnelClient();
  const paired = await client.pair(payload.ticket, {
    code: payload.code,
    deviceName: 'Spike Phone',
    platform: process.platform,
  });
  log('[dial] pair result:', paired);
  if (!paired.ok) process.exit(1);
  let connection = await client.connect(payload.ticket);
  const proxy = await startLocalProxy(
    async () => {
      if (connection.closeReason?.()) connection = await client.connect(payload.ticket);
      return connection;
    },
    { port: 8787 },
  );
  log(`[dial] open http://127.0.0.1:${proxy.port}/ in a browser (try /changes for SSE)`);
}

async function local() {
  process.argv.push('--serve');
  const desktop = await serve();
  const pairing = desktop.activePairing();
  await dial(pairing.qrPayload);
  const response = await fetch('http://127.0.0.1:8787/');
  log('[local] GET / →', response.status, (await response.text()).slice(0, 60));
  const moduleResponse = await fetch('http://127.0.0.1:8787/app.js');
  log('[local] GET /app.js →', moduleResponse.status, await moduleResponse.text());
  log('[local] SPIKE OK');
  process.exit(0);
}

if (args.includes('--local')) await local();
else if (args.includes('--serve')) await serve();
else if (flag('--dial') !== undefined) await dial(flag('--dial'));
else {
  log('usage: spike-pipe.mjs --local | --serve [--upstream URL --token T] | --dial <payload>');
  process.exit(2);
}
