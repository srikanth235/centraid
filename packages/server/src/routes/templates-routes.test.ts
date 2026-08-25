import crypto from "node:crypto";
/*
 * Template catalog over HTTP (#141). The gateway owns the bundled
 * @centraid/blueprints catalog and serves its display metadata at
 * `GET /centraid/_templates`, so the renderer reads it directly instead of
 * through a desktop IPC. We boot serve() and assert the route returns the
 * stripped metadata rows (no `files`/`source`), behind the bearer check.
 */
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

    // No bearer → 401.
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
      // Display metadata present…
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
      // …and the bulky resolver internals stripped.
      expect(t).not.toHaveProperty("files");
      expect(t).not.toHaveProperty("source");
    }

    // `kind` must cross the wire — the renderer's automation gallery filters on
    // it, so dropping it left that surface permanently empty (regression guard).
    const automations = templates.filter((t) => t.kind === "automation");
    expect(automations.length).toBeGreaterThan(0);
    for (const t of automations) {
      // The automation card renders from these display fields.
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
    // Automations declare access on their own manifest, not the app-kind vault
    // block — so they never carry `vault` here.
    for (const t of automations) {
      expect("vault" in t).toBeFalsy();
    }

    // Issue #434: an app-kind template with a declared vault block carries it,
    // so the Discover install/consent sheet can render the requested access.
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

  // The catalog is served from the shipped @centraid/blueprints tree (plus an
  // optional per-gateway cache dir). Constructing the handler must not reach
  // the network for anything.
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
      // Allow a microtask turn for any accidental fire-and-forget.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(0);
  });
});
