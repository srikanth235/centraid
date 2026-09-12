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
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

interface PairQrPayload {
  ticket: string;
  code: string;
}
interface DesktopTunnelHandle {
  endpointId: string;
  beginPairing: (ttlMs: number) => { qrPayload: string };
  activePairing: () => { qrPayload: string } | undefined;
}
interface TunnelConnection {
  closeReason?: () => unknown;
}
interface TunnelClient {
  pair: (
    ticket: string,
    input: { code: string; deviceName: string; platform: string }
  ) => Promise<{ ok: boolean }>;
  connect: (ticket: string) => Promise<TunnelConnection>;
}

const {
  createTunnelClient,
  DeviceStore,
  parsePairQrPayload,
  startDesktopTunnel,
  startLocalProxy,
} = (await import(new URL("../dist/index.js", import.meta.url).href)) as {
  createTunnelClient: () => Promise<TunnelClient>;
  DeviceStore: { open: (path: string) => unknown };
  parsePairQrPayload: (raw: string) => PairQrPayload | null;
  startDesktopTunnel: (options: {
    upstream: () => { baseUrl: string; token: string };
    deviceStore: unknown;
    desktopName: string;
    onPaired: (device: { name: string; endpointId: string }) => void;
  }) => Promise<DesktopTunnelHandle>;
  startLocalProxy: (
    connect: () => Promise<TunnelConnection>,
    options: { port: number }
  ) => Promise<{ port: number }>;
};

// Spike CLI: stdout IS the interface (pair payloads, verdicts).
const log = (...parts: unknown[]): void => {
  process.stdout.write(`${parts.map(String).join(" ")}\n`);
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : undefined;
};

const DEMO_TOKEN = "spike-token";

function startDemoGateway(): Promise<Server> {
  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if ((req.headers.authorization ?? "") !== `Bearer ${DEMO_TOKEN}`) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      if (req.url === "/app.js") {
        res.setHeader("content-type", "text/javascript");
        res.end('import "./kit.js";');
        return;
      }
      if (req.url === "/kit.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(
          'document.body.append(" — ES module chain loaded through the tunnel ✔");'
        );
        return;
      }
      if (req.url === "/changes") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let n = 0;
        const timer = setInterval(
          () => res.write(`data: tick ${++n}\n\n`),
          1000
        );
        req.on("close", () => clearInterval(timer));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        '<html><body>hello from the desktop<script type="module" src="app.js"></script></body></html>'
      );
    }
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function serve() {
  let upstream;
  const upstreamUrl = flag("--upstream");
  if (upstreamUrl) {
    const token = flag("--token") ?? "";
    upstream = () => ({ baseUrl: upstreamUrl, token });
  } else {
    const server = await startDemoGateway();
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("demo gateway did not bind a TCP port");
    }
    const { port } = address satisfies AddressInfo;
    log(`[serve] demo gateway on 127.0.0.1:${port}`);
    upstream = () => ({
      baseUrl: `http://127.0.0.1:${port}`,
      token: DEMO_TOKEN,
    });
  }
  const store = DeviceStore.open(
    path.join(os.tmpdir(), "centraid-spike-devices.json")
  );
  const desktop = await startDesktopTunnel({
    upstream,
    deviceStore: store,
    desktopName: "Spike Desktop",
    onPaired: (device) =>
      log(
        `[serve] paired: ${device.name} (${device.endpointId.slice(0, 10)}…)`
      ),
  });
  const pairing = desktop.beginPairing(30 * 60 * 1000);
  log(`[serve] endpoint ${desktop.endpointId}`);
  log("[serve] pair payload (give to --dial):");
  log(pairing.qrPayload);
  return desktop;
}

async function dial(payloadRaw: string): Promise<void> {
  const payload = parsePairQrPayload(payloadRaw);
  if (!payload) throw new Error("not a centraid pair payload");
  const client = await createTunnelClient();
  const paired = await client.pair(payload.ticket, {
    code: payload.code,
    deviceName: "Spike Phone",
    platform: process.platform,
  });
  log("[dial] pair result:", paired);
  if (!paired.ok) process.exit(1);
  let connection = await client.connect(payload.ticket);
  const proxy = await startLocalProxy(
    async () => {
      if (connection.closeReason?.())
        connection = await client.connect(payload.ticket);
      return connection;
    },
    { port: 8787 }
  );
  log(
    `[dial] open http://127.0.0.1:${proxy.port}/ in a browser (try /changes for SSE)`
  );
}

async function local() {
  process.argv.push("--serve");
  const desktop = await serve();
  const pairing = desktop.activePairing();
  if (pairing === undefined || pairing === null) {
    throw new Error("spike-pipe: expected an active pairing");
  }
  await dial(pairing.qrPayload);
  const response = await fetch("http://127.0.0.1:8787/");
  log("[local] GET / →", response.status, (await response.text()).slice(0, 60));
  const moduleResponse = await fetch("http://127.0.0.1:8787/app.js");
  log(
    "[local] GET /app.js →",
    moduleResponse.status,
    await moduleResponse.text()
  );
  log("[local] SPIKE OK");
  process.exit(0);
}

if (args.includes("--local")) await local();
else if (args.includes("--serve")) await serve();
else if (flag("--dial") === undefined) {
  log(
    "usage: spike-pipe.ts --local | --serve [--upstream URL --token T] | --dial <payload>"
  );
  process.exit(2);
} else {
  const payload = flag("--dial");
  if (payload === undefined) {
    log(
      "usage: spike-pipe.ts --local | --serve [--upstream URL --token T] | --dial <payload>"
    );
    process.exit(2);
  }
  await dial(payload);
}
