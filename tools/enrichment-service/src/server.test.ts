import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServiceConfig } from "./config.js";
import { createServer } from "./server.js";

// An explicitly absent model root makes this suite hermetic even when a
// developer has installed the optional live runtime locally, so every capability's
// isAvailable() naturally resolves false here — which is exactly the
// "honest absence" behavior under test: /capabilities must advertise
// nothing rather than a fake result, and /enrich/<any-capability> must 404
// exactly like an unknown route.

function baseConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    port: 0,
    authToken: undefined,
    transcriptUrl: undefined,
    maxBodyBytes: 64 * 1024 * 1024,
    modelsDir: path.join(import.meta.dirname, "fixtures", "absent-models"),
    ...overrides,
  };
}

let server: ReturnType<typeof createServer> | undefined;
let baseUrl: string;

async function listen(config: ServiceConfig): Promise<void> {
  server = createServer(config);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

describe("enrichment service http server", () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  });

  describe("GET /capabilities", () => {
    beforeEach(async () => {
      await listen(baseConfig());
    });

    it("advertises nothing when no weights are installed and no transcript endpoint is configured", async () => {
      const response = await fetch(`${baseUrl}/capabilities`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        capabilities: {},
      });
    });
  });

  describe("POST /enrich/<cap>", () => {
    beforeEach(async () => {
      await listen(baseConfig());
    });

    it("returns 404 {error: unavailable} for a capability with no installed weights", async () => {
      const response = await fetch(`${baseUrl}/enrich/embed-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "unavailable",
      });
    });

    it("returns 404 {error: unavailable} for a completely unknown capability name", async () => {
      const response = await fetch(`${baseUrl}/enrich/not-a-real-capability`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "unavailable",
      });
    });

    it("returns 400 for a body without an items array", async () => {
      const response = await fetch(`${baseUrl}/enrich/embed-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notItems: true }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const response = await fetch(`${baseUrl}/enrich/embed-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(response.status).toBe(400);
    });
  });

  describe("request body size cap", () => {
    beforeEach(async () => {
      await listen(baseConfig({ maxBodyBytes: 16 }));
    });

    it("returns 413 for a body larger than maxBodyBytes", async () => {
      const response = await fetch(`${baseUrl}/enrich/embed-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [{ id: "1", mediaType: "image/png", bytes: "x".repeat(200) }],
        }),
      });
      expect(response.status).toBe(413);
    });
  });

  describe("bearer auth", () => {
    beforeEach(async () => {
      await listen(baseConfig({ authToken: "secret-token" }));
    });

    it("rejects a request with no Authorization header", async () => {
      const response = await fetch(`${baseUrl}/capabilities`);
      expect(response.status).toBe(401);
    });

    it("rejects a request with the wrong token", async () => {
      const response = await fetch(`${baseUrl}/capabilities`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(response.status).toBe(401);
    });

    it("accepts a request with the correct bearer token", async () => {
      const response = await fetch(`${baseUrl}/capabilities`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(200);
    });
  });

  describe("unknown routes", () => {
    beforeEach(async () => {
      await listen(baseConfig());
    });

    it("returns 404 for a path that isn't /capabilities or /enrich/*", async () => {
      const response = await fetch(`${baseUrl}/nonexistent`);
      expect(response.status).toBe(404);
    });
  });
});
