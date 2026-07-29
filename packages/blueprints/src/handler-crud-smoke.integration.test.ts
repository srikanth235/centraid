/**
 * Behavioural contract for every manifested blueprint handler (#630 Wave 0).
 *
 * The old test merely imported actions and swallowed query errors. This suite
 * invokes every action and query with schema-derived input against a seeded,
 * scope-enforcing vault seam. A handler now fails the suite when it throws,
 * returns the wrong shape, skips its vault operation, or reaches outside the
 * scopes declared in app.json.
 */
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- browser-JS fixtures intentionally lack TS declarations (#408)
// @ts-nocheck
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const here = import.meta.dirname;
const appsRoot = path.resolve(here, "../apps");

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  minimum?: number;
  minLength?: number;
  pattern?: string;
}

interface ManifestHandler {
  name: string;
  input?: JsonSchema;
  output?: JsonSchema;
}

interface VaultScope {
  schema: string;
  table?: string;
  verbs: string;
}

interface AppJson {
  id: string;
  vault: {
    purpose: string;
    scopes: VaultScope[];
  };
  actions?: ManifestHandler[];
  queries?: ManifestHandler[];
}

interface VaultCall {
  method: "invoke" | "read" | "search" | "resolve" | "reveal" | "authenticate";
  target: string;
}

function listBlueprintApps(): string[] {
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

function loadAppJson(appId: string): AppJson {
  return JSON.parse(
    readFileSync(path.join(appsRoot, appId, "app.json"), "utf8")
  ) as AppJson;
}

function handlerPath(
  appId: string,
  kind: "actions" | "queries",
  name: string
): string | null {
  for (const extension of [".ts", ".js", ".mjs"]) {
    const candidate = path.join(appsRoot, appId, kind, `${name}${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  for (const base of [
    path.join(appsRoot, appId),
    path.join(appsRoot, appId, "handlers"),
  ]) {
    for (const extension of [".ts", ".js", ".mjs"]) {
      const candidate = path.join(base, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function stringFixture(name: string, schema: JsonSchema): string {
  if (schema.enum?.length) return String(schema.enum[0]);
  if (name === "data_uri") return "data:text/plain;base64,c2VlZC1maXh0dXJl";
  if (name === "staged_sha") return "a".repeat(64);
  if (name === "phash") return "0f0f";
  if (name === "thumbhash") return "AAAAAA";
  if (name.includes("origin")) return "https://example.test";
  if (name.includes("uri") || name === "url")
    return "https://example.test/seed";
  if (name === "rrule") return "FREQ=DAILY;COUNT=2";
  if (
    name.includes("_at") ||
    name === "from" ||
    name === "to" ||
    name.includes("date")
  )
    return "2026-07-29T09:00:00.000Z";
  if (name === "spent_on") return "2026-07-29";
  return `seed-${name}`.padEnd(schema.minLength ?? 1, "x");
}

function schemaFixture(schema: JsonSchema = {}, name = "value"): unknown {
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type)
    ? (schema.type.find((candidate) => candidate !== "null") ?? "null")
    : schema.type;
  switch (type) {
    case "array":
      return [schemaFixture(schema.items, `${name}_item`)];
    case "boolean":
      return true;
    case "integer":
      return Math.max(1, schema.minimum ?? 1);
    case "number":
      return Math.max(1, schema.minimum ?? 1);
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, property]) => [
          key,
          schemaFixture(property, key),
        ])
      );
    case "null":
      return null;
    default:
      return stringFixture(name, schema);
  }
}

function schemaMismatch(
  value: unknown,
  schema: JsonSchema | undefined,
  location = "$"
): string | null {
  if (!schema?.type) return null;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null)
    return allowed.includes("null") ? null : `${location} is null`;
  if (allowed.includes("object")) {
    if (typeof value !== "object" || Array.isArray(value))
      return `${location} is not an object`;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      const mismatch = schemaMismatch(
        (value as Record<string, unknown>)[key],
        child,
        `${location}.${key}`
      );
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (allowed.includes("array"))
    return Array.isArray(value) ? null : `${location} is not an array`;
  if (allowed.includes("integer"))
    return Number.isInteger(value) ? null : `${location} is not an integer`;
  return allowed.includes(typeof value)
    ? null
    : `${location} has type ${typeof value}, expected ${allowed.join("|")}`;
}

function splitTarget(target: string): { schema: string; table: string } {
  const [schema, ...table] = target.split(".");
  return { schema: schema ?? "", table: table.join(".") };
}

function permits(
  scopes: VaultScope[],
  target: string,
  verb: "read" | "act" | "reveal"
): boolean {
  const parsed = splitTarget(target);
  return scopes.some(
    (scope) =>
      scope.schema === parsed.schema &&
      (scope.table == null || scope.table === parsed.table) &&
      (scope.verbs === verb ||
        scope.verbs.split("+").includes(verb) ||
        (verb === "read" && scope.verbs === "read+act"))
  );
}

function scopedSeededCtx(manifest: AppJson) {
  const calls: VaultCall[] = [];
  const violations: string[] = [];
  const purpose = manifest.vault.purpose;

  function checkPurpose(input: { purpose?: string }) {
    if (input.purpose != null && input.purpose !== purpose)
      violations.push(`purpose ${input.purpose} != ${purpose}`);
  }

  function check(
    method: VaultCall["method"],
    target: string,
    verb: "read" | "act" | "reveal"
  ) {
    calls.push({ method, target });
    if (!permits(manifest.vault.scopes, target, verb))
      violations.push(`${method} ${target} lacks ${verb} scope`);
  }

  return {
    calls,
    violations,
    ctx: {
      vault: {
        invoke: async (input: {
          command: string;
          purpose?: string;
          input?: unknown;
        }) => {
          checkPurpose(input);
          check("invoke", input.command, "act");
          return {
            status: "executed",
            output: { id: `seed-${input.command.replaceAll(".", "-")}` },
          };
        },
        read: async (input: { entity: string; purpose?: string }) => {
          checkPurpose(input);
          check("read", input.entity, "read");
          // core.vault is the one universal seeded record. Other projections
          // intentionally exercise their honest empty-state branch.
          return {
            rows:
              input.entity === "core.vault"
                ? [
                    {
                      vault_id: "seed-vault",
                      owner_party_id: "seed-owner",
                      base_currency: "USD",
                    },
                  ]
                : [],
          };
        },
        search: async (input: {
          entities?: string[];
          entity?: string;
          purpose?: string;
        }) => {
          checkPurpose(input);
          for (const entity of input.entities ?? [input.entity].filter(Boolean))
            check("search", entity, "read");
          return { rows: [] };
        },
        resolve: async (input: { purpose?: string }) => {
          checkPurpose(input);
          calls.push({ method: "resolve", target: "declared refs" });
          return { cards: [] };
        },
        reveal: async (input: { entity: string; purpose?: string }) => {
          checkPurpose(input);
          check("reveal", input.entity, "reveal");
          return { values: {}, receiptId: "seed-receipt" };
        },
        authenticate: async () => {
          calls.push({ method: "authenticate", target: "locker.auth" });
          return {
            ok: true,
            configured: true,
            authenticated: true,
            sessionToken: "seed-auth-session",
            itemToken: "seed-item-permit",
          };
        },
      },
    },
  };
}

const importHandler = (absolutePath: string) => {
  let relative = path.relative(here, absolutePath);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return import(relative.split(path.sep).join("/"));
};

describe("blueprint handler behavioural contract", () => {
  const apps = listBlueprintApps();
  const manifests = apps.map((appId) => ({
    appId,
    manifest: loadAppJson(appId),
  }));
  const actionCases = manifests.flatMap(({ appId, manifest }) =>
    (manifest.actions ?? []).map((handler) => ({
      appId,
      manifest,
      handler,
    }))
  );
  const queryCases = manifests.flatMap(({ appId, manifest }) =>
    (manifest.queries ?? []).map((handler) => ({
      appId,
      manifest,
      handler,
    }))
  );

  test("repo ships the expected eight built-in blueprint apps", () => {
    expect(apps).toHaveLength(8);
  });

  test.each(actionCases)(
    "$appId action $handler.name invokes a declared command and returns its contract",
    async ({ appId, manifest, handler }) => {
      const file = handlerPath(appId, "actions", handler.name);
      expect(
        file,
        `${appId} action ${handler.name} missing handler file`
      ).toBeTruthy();
      const module = await importHandler(file!);
      expect(module.default).toBeTypeOf("function");
      const seam = scopedSeededCtx(manifest);
      const input = schemaFixture(handler.input);

      const result = await module.default({
        body: input,
        input,
        query: input,
        ctx: seam.ctx,
      });

      expect(result).toMatchObject({ status: 200 });
      expect(schemaMismatch(result.body, handler.output)).toBeNull();
      expect(
        seam.calls.filter((call) => call.method === "invoke")
      ).toHaveLength(1);
      expect(seam.violations).toStrictEqual([]);
    }
  );

  test.each(queryCases)(
    "$appId query $handler.name reads only declared scopes and returns its contract",
    async ({ appId, manifest, handler }) => {
      const file = handlerPath(appId, "queries", handler.name);
      expect(
        file,
        `${appId} query ${handler.name} missing handler file`
      ).toBeTruthy();
      const module = await importHandler(file!);
      expect(module.default).toBeTypeOf("function");
      const seam = scopedSeededCtx(manifest);
      const input = schemaFixture(handler.input);

      const result = await module.default({
        body: input,
        input,
        query: input,
        ctx: seam.ctx,
      });

      expect(schemaMismatch(result, handler.output)).toBeNull();
      expect(
        seam.calls.length,
        `${appId}.${handler.name} did not exercise the vault`
      ).toBeGreaterThan(0);
      expect(seam.violations).toStrictEqual([]);
    }
  );
});
