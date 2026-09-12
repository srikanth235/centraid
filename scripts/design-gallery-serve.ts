// Serve the built web shell and compare gallery PNGs for `design-gallery.ts`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
export const WEB_DIR = path.join(ROOT, "apps/web");
export const WEB_DIST = path.join(WEB_DIR, "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function ensureWebShellInputs(): void {
  execFileSync(
    "bun",
    ["run", "turbo", "run", "build", "--filter=@centraid/web^..."],
    { cwd: ROOT, stdio: "inherit" }
  );
  const fontFaces = path.join(ROOT, "packages/design/dist/font-faces.js");
  if (!existsSync(fontFaces))
    throw new Error(
      "web dependency build produced no packages/design/dist/font-faces.js (required by apps/web vite.config)"
    );
}

/**
 * Rebuild the web dist before every run. The alternative — trusting whatever
 * `apps/web/dist` happens to hold — is how a "verified" baseline ends up
 * photographing a bundle nobody has built since the change under review.
 */
export function buildWebShell(): void {
  ensureWebShellInputs();
  execFileSync("bunx", ["vite", "build", "--logLevel", "warn"], {
    cwd: WEB_DIR,
    stdio: "inherit",
  });
  if (!existsSync(path.join(WEB_DIST, "index.html")))
    throw new Error("apps/web build produced no dist/index.html");
}

/** Serve the dist on an ephemeral port so `/fonts/*` resolves same-origin. */
export async function serveDist(): Promise<{
  origin: string;
  server: ReturnType<typeof createServer>;
}> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]?.split("#")[0] ?? "/";
    const rel = url === "/" ? "/index.html" : url;
    const file = path.join(WEB_DIST, path.normalize(rel));
    if (!file.startsWith(WEB_DIST)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.setHeader(
        "Content-Type",
        CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
      );
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("design-gallery: expected a TCP listen address");
  const { port } = address as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

export function diffPng(
  expected: PNG,
  actual: PNG
): { changed: number; max: number; reason: string } {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { changed: 1, max: 255, reason: "dimensions differ" };
  }
  let changed = 0;
  let max = 0;
  const pixels = expected.width * expected.height;
  for (let index = 0; index < expected.data.length; index += 4) {
    const delta = Math.max(
      Math.abs((expected.data[index] ?? 0) - (actual.data[index] ?? 0)),
      Math.abs((expected.data[index + 1] ?? 0) - (actual.data[index + 1] ?? 0)),
      Math.abs((expected.data[index + 2] ?? 0) - (actual.data[index + 2] ?? 0)),
      Math.abs((expected.data[index + 3] ?? 0) - (actual.data[index + 3] ?? 0))
    );
    max = Math.max(max, delta);
    if (delta > 8) changed += 1;
  }
  return { changed: changed / pixels, max, reason: "pixel delta" };
}
