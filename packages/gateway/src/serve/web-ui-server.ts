import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

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
      try {
        if (!resolved) throw new Error('outside root');
        bytes = await fs.readFile(resolved);
      } catch {
        served = path.join(options.rootDir, 'index.html');
        try {
          bytes = await fs.readFile(served);
        } catch {
          res.writeHead(404).end();
          return;
        }
      }
      const extension = path.extname(served ?? path.join(options.rootDir, 'index.html'));
      const apiOrigin = new URL(options.apiUrl).origin;
      res.setHeader('content-type', TYPES[extension] ?? 'application/octet-stream');
      res.setHeader(
        'cache-control',
        extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      if (extension === '.html') {
        res.setHeader(
          'content-security-policy',
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${apiOrigin}; frame-src ${apiOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
        );
      }
      res.writeHead(200);
      res.end(bytes);
    })().catch(() => res.writeHead(500).end());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
