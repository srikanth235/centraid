import { describe, expect, it } from "vitest";

import { DEFAULT_PORT, loadConfig } from "./config.js";

describe(loadConfig, () => {
  it("falls back to documented defaults when no env vars are set", () => {
    const config = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.authToken).toBeUndefined();
    expect(config.transcriptUrl).toBeUndefined();
    expect(config.maxBodyBytes).toBe(64 * 1024 * 1024);
  });

  it("reads ENRICH_SERVICE_PORT when it's a valid positive integer", () => {
    expect(loadConfig({ ENRICH_SERVICE_PORT: "9001" }).port).toBe(9001);
  });

  it("ignores an invalid ENRICH_SERVICE_PORT and falls back to the default", () => {
    expect(loadConfig({ ENRICH_SERVICE_PORT: "not-a-number" }).port).toBe(
      DEFAULT_PORT
    );
    expect(loadConfig({ ENRICH_SERVICE_PORT: "-5" }).port).toBe(DEFAULT_PORT);
  });

  it("reads ENRICH_SERVICE_TOKEN as the auth token", () => {
    expect(loadConfig({ ENRICH_SERVICE_TOKEN: "abc123" }).authToken).toBe(
      "abc123"
    );
  });

  it("reads ENRICH_SERVICE_TRANSCRIPT_URL", () => {
    expect(
      loadConfig({ ENRICH_SERVICE_TRANSCRIPT_URL: "http://localhost:9000" })
        .transcriptUrl
    ).toBe("http://localhost:9000");
  });

  it("reads a custom ENRICH_SERVICE_MAX_BODY_BYTES", () => {
    expect(
      loadConfig({ ENRICH_SERVICE_MAX_BODY_BYTES: "1024" }).maxBodyBytes
    ).toBe(1024);
  });
});
