import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";
import { makeTemplatesRouteHandler } from "./templates-routes.ts";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

describe("templates-routes scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gateway-templates-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("GET /centraid/_templates returns stripped bundled metadata behind auth", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });

    const unauth = await fetch(`${handle.url}/centraid/_templates`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`${handle.url}/centraid/_templates`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(200);
    const templates = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);

    for (const t of templates) {
      for (const key of [
        "id",
        "name",
        "desc",
        "colorKey",
        "iconKey",
        "version",
      ]) {
        expect(t).toHaveProperty(key);
      }
      expect(t).not.toHaveProperty("files");
      expect(t).not.toHaveProperty("source");
    }

    const automations = templates.filter((t) => t.kind === "automation");
    expect(automations.length).toBeGreaterThan(0);
    for (const t of automations) {
      for (const key of [
        "emoji",
        "category",
        "triggerKind",
        "triggerLabel",
        "integrations",
      ]) {
        expect(t).toHaveProperty(key);
      }
    }
    for (const t of automations) {
      expect("vault" in t).toBeFalsy();
    }

    const photos = templates.find((t) => t.id === "photos");
    expect(photos).toBeDefined();
    const vault = photos?.vault as
      | {
          why?: string;
          scopes?: Array<{ schema: string; table?: string; verbs: string }>;
        }
      | undefined;
    expect(vault).toBeDefined();
    expect(vault?.why).toBeTypeOf("string");
    expect(Array.isArray(vault?.scopes)).toBe(true);
    expect(vault?.scopes?.length ?? 0).toBeGreaterThan(0);
    expect(
      vault?.scopes?.every(
        (s) => typeof s.schema === "string" && typeof s.verbs === "string"
      )
    ).toBe(true);
  });

  test("constructing the handler performs no network fetch", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      makeTemplatesRouteHandler({
        cacheDir: path.join(dataDir, "tmpl-cache"),
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(0);
  });
});
