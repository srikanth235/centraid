import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  GATEWAY_SHUTDOWN_GRACE_MS,
  tuneGatewayHttpServer,
} from "@centraid/server/engine";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  // `WebAssembly.instantiateStreaming` needs this exact type.
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/**
 * NEVER hand a browser an immutable copy of a file whose URL never changes.
 * Only content-hashed `/assets/` files may be `immutable`.
 */
function cacheControlFor(
  rootDir: string,
  served: string,
  extension: string
): string {
  if (extension === ".html") return "no-store";
  const relative = path.relative(rootDir, served);
  if (relative.startsWith(`assets${path.sep}`)) {
    return "public, max-age=31536000, immutable";
  }
  const base = path.basename(served);
  // These gate app updates.
  if (base === "sw.js" || extension === ".webmanifest") return "no-cache";
  // Unhashed root files: brief cache, always revalidating.
  return "public, max-age=3600, must-revalidate";
}

export interface WebUiServerOptions {
  rootDir: string;
  apiUrl: string;
  host?: string;
  port?: number;
}

export interface WebUiServerHandle {
  url: string;
  close: () => Promise<void>;
}

function fileFor(rootDir: string, pathname: string): string | undefined {
  const relative =
    pathname === "/"
      ? "index.html"
      : decodeURIComponent(pathname).replace(/^\/+/u, "");
  const resolved = path.resolve(rootDir, relative);
  const root = path.resolve(rootDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
    ? resolved
    : undefined;
}

function stampShellNonce(bytes: Buffer, nonce: string): Buffer {
  let html = bytes
    .toString("utf8")
    .replace(/<script\b(?<attributes>[^>]*)>/giu, (tag, attributes: string) => {
      if (/\bnonce\s*=/iu.test(attributes)) return tag;
      return `<script${attributes} nonce="${nonce}">`;
    });
  const marker = `<meta name="centraid-csp-nonce" content="${nonce}">`;
  const head = /<head\b[^>]*>/iu.exec(html);
  const doctype = head ? undefined : /<!doctype\s+html\s*>/iu.exec(html);
  const at = head
    ? head.index + head[0].length
    : (doctype?.index ?? 0) + (doctype?.[0].length ?? 0);
  html = html.slice(0, at) + marker + html.slice(at);
  return Buffer.from(html, "utf8");
}

function acceptedSidecar(req: http.IncomingMessage): ".br" | ".gz" | undefined {
  const accepted = String(req.headers["accept-encoding"] ?? "");
  if (/(?:^|,)\s*br(?:\s*;|\s*,|\s*$)/iu.test(accepted)) return ".br";
  if (/(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/iu.test(accepted)) return ".gz";
  return undefined;
}

export async function startWebUiServer(
  options: WebUiServerOptions
): Promise<WebUiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://web.invalid").pathname;
      if (pathname === "/web-config.json") {
        res.writeHead(200, {
          "content-type": TYPES[".json"],
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ gatewayUrl: options.apiUrl }));
        return;
      }
      const resolved = fileFor(options.rootDir, pathname);
      let bytes: Buffer;
      let served = resolved;
      let contentEncoding: string | undefined;
      try {
        if (!resolved) throw new Error("outside root");
        const sidecar =
          path.extname(resolved) === ".html" ? undefined : acceptedSidecar(req);
        if (sidecar) {
          try {
            bytes = await fs.readFile(`${resolved}${sidecar}`);
            contentEncoding = sidecar === ".br" ? "br" : "gzip";
          } catch {
            bytes = await fs.readFile(resolved);
          }
        } else {
          bytes = await fs.readFile(resolved);
        }
      } catch {
        served = path.join(options.rootDir, "index.html");
        try {
          bytes = await fs.readFile(served);
        } catch {
          res.writeHead(404).end();
          return;
        }
      }
      const servedPath = served ?? path.join(options.rootDir, "index.html");
      const extension = path.extname(servedPath);
      const apiOrigin = new URL(options.apiUrl).origin;
      res.setHeader(
        "content-type",
        TYPES[extension] ?? "application/octet-stream"
      );
      res.setHeader(
        "cache-control",
        cacheControlFor(options.rootDir, servedPath, extension)
      );
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (contentEncoding) {
        res.setHeader("content-encoding", contentEncoding);
        res.setHeader("vary", "Accept-Encoding");
      }
      if (extension === ".html") {
        const scriptNonce = crypto.randomBytes(16).toString("base64");
        bytes = stampShellNonce(bytes, scriptNonce);
        // Each relaxation below is load-bearing: `'wasm-unsafe-eval'` runs the
        // Iroh module, `https:`/`wss:` reach the relay, `data:`/`blob:` carry
        // the opaque-origin app document, and `blob:` in `frame-src` lets an
        // inline app EMBED bytes it already fetched. NEVER admit
        // `unsafe-inline`: the shell stays nonce-only.
        res.setHeader(
          "content-security-policy",
          `default-src 'self'; script-src 'self' 'nonce-${scriptNonce}' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' ${apiOrigin} https: wss:; frame-src 'self' data: blob: ${apiOrigin}; object-src blob:; base-uri 'self'; frame-ancestors 'none'`
        );
      }
      res.writeHead(200);
      res.end(bytes);
    })().catch(() => res.writeHead(500).end());
  });
  tuneGatewayHttpServer(server);

  // NEVER let a port collision propagate — the API is the critical plane.
  // `EADDRINUSE` retries once on an ephemeral port; `handle.url` is the truth.
  const requestedPort = options.port ?? 0;
  const listenOn = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  try {
    await listenOn(requestedPort);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && requestedPort !== 0) {
      process.stderr.write(
        `[centraid-web-ui] port ${requestedPort} is in use — falling back to an ephemeral port\n`
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
        // `server.close()` resolves only once every connection ends, and an
        // open `text/event-stream` never does — one subscriber would wedge the
        // teardown `serve()` awaits.
        let force: ReturnType<typeof setTimeout> | undefined = undefined;
        server.close((error) => {
          if (force) clearTimeout(force);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections();
        force = setTimeout(
          () => server.closeAllConnections(),
          GATEWAY_SHUTDOWN_GRACE_MS
        );
      }),
  };
}
