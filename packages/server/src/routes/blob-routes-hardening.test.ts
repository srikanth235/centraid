import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { DATA_PLANE_RELAY_HEADER } from "../serve/data-plane-handoff.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { makeBlobRouteHandler } from "./blob-routes.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const cleanups: Array<() => Promise<void> | void> = [];

describe("blob-routes-hardening", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(dataPlane?: {
    baseUrl: string;
    secret: string;
  }): Promise<{ base: string; plane: VaultPlane }> {
    const dir = await tempDir(`blob-hardening-${crypto.randomUUID()}-`);
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    const handler = makeBlobRouteHandler(
      { current: () => plane },
      dataPlane ? { ...dataPlane, rootDir: dir } : undefined
    );
    const server = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const address = server.address() as { port: number };
    return {
      base: `http://127.0.0.1:${address.port}/centraid/_vault/blobs`,
      plane,
    };
  }

  async function stageAndClaim(
    base: string,
    plane: VaultPlane,
    filename: string,
    bytes: Uint8Array = PNG_BYTES
  ): Promise<string> {
    const staged = (await (
      await fetch(`${base}?filename=${filename}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      })
    ).json()) as { sha256: string };
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "core.add_document",
      input: { staged_sha: staged.sha256, title: filename },
    });
    return (outcome as { output: { content_id: string } }).output.content_id;
  }

  test("aborting a blob response destroys its source stream immediately", async () => {
    const { base, plane } = await fixture();
    const contentId = await stageAndClaim(base, plane, "abort.png");
    let emitted = false;
    const slow = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(PNG_BYTES.subarray(0, 1));
      },
    });
    vi.spyOn(plane.db.blobs, "openReadStreamSync").mockReturnValue({
      stream: slow,
      size: PNG_BYTES.length,
      range: { start: 0, end: PNG_BYTES.length - 1 },
    });

    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${base}/${contentId}`, (response) => {
        response.once("data", () => response.destroy());
        response.once("close", resolve);
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    const waitForDestroy = async (attempt: number): Promise<void> => {
      if (attempt >= 50 || slow.destroyed) return;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return waitForDestroy(attempt + 1);
    };
    await waitForDestroy(0);
    expect(slow.destroyed).toBe(true);
  });

  test("redirects only trusted relay requests and never caches the one-use handoff", async () => {
    const secret = "relay-proof-secret";
    const { base, plane } = await fixture({
      baseUrl: "http://127.0.0.1:9",
      secret,
    });
    const contentId = await stageAndClaim(base, plane, "handoff.png");

    const direct = await fetch(`${base}/${contentId}`, { redirect: "manual" });
    expect(direct.status).toBe(200);
    expect(direct.headers.get("location")).toBeNull();
    expect(Buffer.from(await direct.arrayBuffer())).toStrictEqual(PNG_BYTES);

    const relayed = await fetch(`${base}/${contentId}`, {
      redirect: "manual",
      headers: { [DATA_PLANE_RELAY_HEADER]: secret },
    });
    expect(relayed.status).toBe(307);
    expect(relayed.headers.get("location")).toMatch(
      /^http:\/\/127\.0\.0\.1:9\/v1\/blob\?/u
    );
    expect(relayed.headers.get("cache-control")).toBe("no-store");
    await expect(relayed.text()).resolves.toBe("");

    const forged = await fetch(`${base}/${contentId}`, {
      redirect: "manual",
      headers: { [DATA_PLANE_RELAY_HEADER]: "not-the-secret" },
    });
    expect(forged.status).toBe(200);
  });

  test("web-executable blob types are forced to attachment with nosniff + sandbox (issue #865)", async () => {
    const { base, plane } = await fixture();
    const page =
      "<html><body><script>fetch('/centraid/_gateway/owners')</script></body></html>";
    const contentId = await stageAndClaim(
      base,
      plane,
      "page.html",
      Buffer.from(page)
    );

    // A stored HTML blob is attacker-authorable (imported email attachment):
    // served inline it would be stored XSS in the shell's origin, so it
    // downloads instead — and even a mislabeled type cannot be sniffed into
    // a scriptable one or escape the sandbox.
    const page_ = await fetch(`${base}/${contentId}`);
    expect(page_.headers.get("content-type")).toBe("text/html");
    expect(page_.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(page_.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page_.headers.get("content-security-policy")).toBe("sandbox");
    await expect(page_.text()).resolves.toBe(page);

    // Benign types keep their inline disposition but carry the same guards.
    const pngId = await stageAndClaim(base, plane, "guarded.png");
    const guarded = await fetch(`${base}/${pngId}`);
    expect(guarded.headers.get("content-disposition")).toBe(
      'inline; filename="guarded.png"'
    );
    expect(guarded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(guarded.headers.get("content-security-policy")).toBe("sandbox");
  });

  test("returns a clean uncached 404 when metadata exists but custody bytes are missing", async () => {
    const { base, plane } = await fixture();
    const contentId = await stageAndClaim(base, plane, "missing.png");
    vi.spyOn(plane.db.blobs, "openReadStreamSync").mockReturnValue(null);
    vi.spyOn(plane.db.blobs, "openRemoteReadStream").mockReturnValue(null);
    vi.spyOn(plane.db.blobs, "open").mockResolvedValue(null);

    const response = await fetch(`${base}/${contentId}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    await expect(response.json()).resolves.toStrictEqual({
      error: "bytes missing from custody",
    });
  });

  test("a source error after headers closes only that response and keeps the server alive", async () => {
    const { base, plane } = await fixture();
    const contentId = await stageAndClaim(base, plane, "stream-error.png");
    const broken = new Readable({
      read() {
        this.push(PNG_BYTES.subarray(0, 1));
        queueMicrotask(() =>
          this.destroy(new Error("simulated storage failure"))
        );
      },
    });
    vi.spyOn(plane.db.blobs, "openReadStreamSync").mockReturnValue({
      stream: broken,
      size: PNG_BYTES.length,
      range: { start: 0, end: PNG_BYTES.length - 1 },
    });

    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${base}/${contentId}`, (response) => {
        response.resume();
        response.once("aborted", resolve);
        response.once("error", resolve);
        response.once("end", () =>
          reject(new Error("broken response unexpectedly completed"))
        );
      });
      request.once("error", resolve);
    });
    expect((await fetch(`${base}/does-not-exist`)).status).toBe(404);
  });
});
