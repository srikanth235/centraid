import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { GATEWAY_SHUTDOWN_GRACE_MS, tuneGatewayHttpServer } from '@centraid/app-engine';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  // `application/wasm` is required for `WebAssembly.instantiateStreaming`,
  // which the browser Iroh/WASM transport uses to load `*_bg.wasm`. Without
  // it the file is served as `application/octet-stream` and wasm-bindgen
  // falls back (with a console warning) to a slower non-streaming path.
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Cache policy for a served asset.
 *
 * Invariant: never hand a browser a year-immutable copy of a file whose URL
 * never changes. Only Vite's content-hashed assets (emitted under `/assets/`
 * with a hash in the filename) get `immutable`. Everything else at the web
 * root has a stable URL (`sw.js`, `manifest.webmanifest`, `centraid.svg`, the
 * stable-named `*_bg.wasm`), so a long immutable cache would strand updates.
 * `.html` is always revalidated (`no-store`); the service worker and manifest
 * must revalidate on every load so a redeploy is picked up promptly; other
 * unhashed root files get a modest, revalidating cache.
 */
function cacheControlFor(rootDir: string, served: string, extension: string): string {
  if (extension === '.html') return 'no-store';
  const relative = path.relative(rootDir, served);
  if (relative.startsWith(`assets${path.sep}`)) {
    return 'public, max-age=31536000, immutable';
  }
  const base = path.basename(served);
  // The service worker and web manifest gate app updates — always revalidate.
  if (base === 'sw.js' || extension === '.webmanifest') return 'no-cache';
  // Other unhashed root files (icons, the stable-named wasm) can be cached
  // briefly but must revalidate rather than be pinned for a year.
  return 'public, max-age=3600, must-revalidate';
}

export interface WebUiServerOptions {
  rootDir: string;
  apiUrl: string;
  host?: string;
  port?: number;
}

export interface WebUiServerHandle {
  url: string;
  close(): Promise<void>;
}

function fileFor(rootDir: string, pathname: string): string | undefined {
  const relative =
    pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, relative);
  const root = path.resolve(rootDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function stampShellNonce(bytes: Buffer, nonce: string): Buffer {
  let html = bytes.toString('utf8').replace(/<script\b([^>]*)>/gi, (tag, attributes: string) => {
    if (/\bnonce\s*=/i.test(attributes)) return tag;
    return `<script${attributes} nonce="${nonce}">`;
  });
  const marker = `<meta name="centraid-csp-nonce" content="${nonce}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    html = html.slice(0, at) + marker + html.slice(at);
  } else {
    const doctype = /<!doctype\s+html\s*>/i.exec(html);
    const at = doctype ? doctype.index + doctype[0].length : 0;
    html = html.slice(0, at) + marker + html.slice(at);
  }
  return Buffer.from(html, 'utf8');
}

function acceptedSidecar(req: http.IncomingMessage): '.br' | '.gz' | undefined {
  const accepted = String(req.headers['accept-encoding'] ?? '');
  if (/(?:^|,)\s*br(?:\s*;|\s*,|\s*$)/i.test(accepted)) return '.br';
  if (/(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(accepted)) return '.gz';
  return undefined;
}

export async function startWebUiServer(options: WebUiServerOptions): Promise<WebUiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://web.invalid').pathname;
      if (pathname === '/web-config.json') {
        res.writeHead(200, {
          'content-type': TYPES['.json'],
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ gatewayUrl: options.apiUrl }));
        return;
      }
      const resolved = fileFor(options.rootDir, pathname);
      let bytes: Buffer;
      let served = resolved;
      let contentEncoding: string | undefined;
      try {
        if (!resolved) throw new Error('outside root');
        const sidecar = path.extname(resolved) === '.html' ? undefined : acceptedSidecar(req);
        if (sidecar) {
          try {
            bytes = await fs.readFile(`${resolved}${sidecar}`);
            contentEncoding = sidecar === '.br' ? 'br' : 'gzip';
          } catch {
            bytes = await fs.readFile(resolved);
          }
        } else {
          bytes = await fs.readFile(resolved);
        }
      } catch {
        served = path.join(options.rootDir, 'index.html');
        try {
          bytes = await fs.readFile(served);
        } catch {
          res.writeHead(404).end();
          return;
        }
      }
      const servedPath = served ?? path.join(options.rootDir, 'index.html');
      const extension = path.extname(servedPath);
      const apiOrigin = new URL(options.apiUrl).origin;
      res.setHeader('content-type', TYPES[extension] ?? 'application/octet-stream');
      res.setHeader('cache-control', cacheControlFor(options.rootDir, servedPath, extension));
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      if (contentEncoding) {
        res.setHeader('content-encoding', contentEncoding);
        res.setHeader('vary', 'Accept-Encoding');
      }
      if (extension === '.html') {
        const scriptNonce = crypto.randomBytes(16).toString('base64');
        bytes = stampShellNonce(bytes, scriptNonce);
        // The PWA's headline feature is ticket-only, relay-only Iroh/WASM
        // pairing/transport. That requires three relaxations vs. a plain
        // static-app CSP:
        //   - `'wasm-unsafe-eval'` in `script-src` so `WebAssembly.instantiate`
        //     may run the Iroh WASM module.
        //   - `https:`/`wss:` in `connect-src` so browser Iroh (relay-only) can
        //     open its `wss://` WebSocket + HTTP to the n0 relay. Broad `wss:`/
        //     `https:` is acceptable for a self-hosted personal gateway.
        //   - `data:` in `frame-src` plus the response nonce and `blob:` in
        //     `script-src` for the self-contained, opaque-origin app document.
        //     Data documents inherit this policy container, so their inlined
        //     scripts carry the shell nonce and query modules use blob URLs.
        //     The shell itself retains nonce-only inline execution; it never
        //     admits `unsafe-inline`. `${apiOrigin}` stays for naturally
        //     cross-origin direct-HTTP mode.
        res.setHeader(
          'content-security-policy',
          `default-src 'self'; script-src 'self' 'nonce-${scriptNonce}' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' ${apiOrigin} https: wss:; frame-src 'self' data: ${apiOrigin}; object-src blob:; base-uri 'self'; frame-ancestors 'none'`,
        );
      }
      res.writeHead(200);
      res.end(bytes);
    })().catch(() => res.writeHead(500).end());
  });
  tuneGatewayHttpServer(server);

  // Bind the requested port, but degrade gracefully on a collision. The daemon
  // derives the web port from its API port (`config.port + 1`); if some
  // unrelated process already holds that port we must NOT let the rejection
  // propagate and take down the whole gateway — the API is the critical plane,
  // the web UI is secondary. On `EADDRINUSE` we retry once on an ephemeral
  // port (0) and log a warning so the moved port is never silently surprising;
  // `handle.url` then reflects the real, listening port.
  const requestedPort = options.port ?? 0;
  const listenOn = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
  try {
    await listenOn(requestedPort);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && requestedPort !== 0) {
      process.stderr.write(
        `[centraid-web-ui] port ${requestedPort} is in use — falling back to an ephemeral port\n`,
      );
      await listenOn(0);
    } else {
      throw error;
    }
  }
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Same defect as the runtime HTTP server: `server.close()` only
        // resolves once every connection has ended, and an active
        // `text/event-stream` response never ends on its own — so a single
        // subscribed client would pin this listener open forever. `serve()`
        // awaits this during teardown, so that wedges a gateway switch or
        // quit. Stop accepting, hurry the idle sockets along, then destroy
        // whatever is left after the grace window.
        let force: ReturnType<typeof setTimeout> | undefined;
        server.close((error) => {
          if (force) clearTimeout(force);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections();
        force = setTimeout(() => server.closeAllConnections(), GATEWAY_SHUTDOWN_GRACE_MS);
      }),
  };
}
