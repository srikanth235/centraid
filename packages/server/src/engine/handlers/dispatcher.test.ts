import nodeFs from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
// The dispatcher after #286 phase 2: declared-handler routing ONLY.
// What must hold: manifest lookup + Ajv validation + worker hand-off work;
// `_sql` and every other underscore name is just an unknown handler now;
// describe returns the manifest (there is no per-app schema to read).
import path from "node:path";

import { assert, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { Registry } from "../registry/registry.js";
import { Dispatcher } from "./dispatcher.js";

let appsDir: string;
let codeDir: string;
let registry: Registry;
let dispatcher: Dispatcher;
let notified: string[];

const MANIFEST = {
  manifestVersion: 1,
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  actions: [
    {
      name: "add_note",
      confirmation: "none",
      input: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
        additionalProperties: false,
      },
    },
  ],
  queries: [
    {
      name: "list_notes",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
};

/** `fs.promises` is one live object, so the dispatcher's `stat` is countable
 *  by replacing the method on it — an ESM namespace import is not spyable. */
function countStats(): { calls: () => number; restore: () => void } {
  const target = nodeFs.promises as unknown as Record<string, unknown>;
  const real = target.stat as (...args: unknown[]) => unknown;
  let calls = 0;
  target.stat = (...args: unknown[]) => {
    calls += 1;
    return real.apply(target, args);
  };
  return {
    calls: () => calls,
    restore: () => {
      target.stat = real;
    },
  };
}

describe("dispatcher", () => {
  beforeEach(async () => {
    appsDir = await tempDir("centraid-dispatch-");
    codeDir = path.join(appsDir, "code");
    await mkdir(path.join(codeDir, "actions"), { recursive: true });
    await mkdir(path.join(codeDir, "queries"), { recursive: true });
    await writeFile(path.join(codeDir, "app.json"), JSON.stringify(MANIFEST));
    await writeFile(
      path.join(codeDir, "actions", "add_note.js"),
      `export default async ({ body }) => ({ status: 200, body: { added: body.title } });`
    );
    await writeFile(
      path.join(codeDir, "queries", "list_notes.js"),
      `export default async () => ({ notes: [] });`
    );
    registry = new Registry(appsDir);
    await registry.load();
    await registry.ensureUploaded("demo");
    notified = [];
    dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async () => codeDir,
      onWriteFor: (appId) => () => notified.push(appId),
    });
  });

  describe("TypeScript handlers", () => {
    it("prefers a precompiled .js over the .ts source of the same name", async () => {
      // Both files exist for the declared `add_note`. A first-party app ships
      // the compiled sibling (#922 B2), so THAT is what runs: the TS source is
      // what nobody compiled, and only that path boots the loader hook.
      await writeFile(
        path.join(codeDir, "actions", "add_note.ts"),
        `interface Body { title: string }\n` +
          `export default async ({ body }: { body: Body }) => ({ status: 200, body: { added: 'TS:' + body.title } });`
      );
      const out = await dispatcher.write({
        app: "demo",
        action: "add_note",
        input: { title: "x" },
      });
      expect(out.isError).toBe(false);
      expect(out.structuredContent).toStrictEqual({ added: "x" });
    });

    it("falls back to the .ts source when nothing precompiled it", async () => {
      await rm(path.join(codeDir, "actions", "add_note.js"));
      await writeFile(
        path.join(codeDir, "actions", "add_note.ts"),
        `interface Body { title: string }\n` +
          `export default async ({ body }: { body: Body }) => ({ status: 200, body: { added: 'TS:' + body.title } });`
      );
      const out = await dispatcher.write({
        app: "demo",
        action: "add_note",
        input: { title: "x" },
      });
      expect(out.isError).toBe(false);
      expect(out.structuredContent).toStrictEqual({ added: "TS:x" });
    });

    it("does not stat the manifest or the handler on every dispatch", async () => {
      // App code changes when a version is published, not per request, so the
      // mtime check is coalesced instead of paid per invocation (#922 B2).
      const counted = countStats();
      try {
        await dispatcher.read({ app: "demo", query: "list_notes" });
        const afterFirst = counted.calls();
        expect(afterFirst).toBeGreaterThan(0);
        await dispatcher.read({ app: "demo", query: "list_notes" });
        await dispatcher.read({ app: "demo", query: "list_notes" });
        expect(counted.calls()).toBe(afterFirst);
      } finally {
        counted.restore();
      }
    });

    it("invalidate() drops the resolved handler as well as the manifest", async () => {
      await dispatcher.read({ app: "demo", query: "list_notes" });
      dispatcher.invalidate(codeDir);
      const counted = countStats();
      try {
        await dispatcher.read({ app: "demo", query: "list_notes" });
        expect(counted.calls()).toBeGreaterThan(0);
      } finally {
        counted.restore();
      }
    });

    it("dispatches a .ts action and a .ts query, each with a relative .ts sibling import", async () => {
      // Nothing precompiled these, which is what puts them on the TS-loader
      // path: the compiled sibling would win otherwise (#922 B2).
      await rm(path.join(codeDir, "actions", "add_note.js"));
      await rm(path.join(codeDir, "queries", "list_notes.js"));
      await writeFile(
        path.join(codeDir, "actions", "helper.ts"),
        `export function shout(s: string): string { return s.toUpperCase(); }`
      );
      await writeFile(
        path.join(codeDir, "actions", "add_note.ts"),
        `import { shout } from './helper.js';\n` +
          `interface Body { title: string }\n` +
          `export default async ({ body }: { body: Body }) => ({ status: 200, body: { added: shout(body.title) } });`
      );
      await writeFile(
        path.join(codeDir, "queries", "countHelper.ts"),
        `export const seed: number = 3;`
      );
      await writeFile(
        path.join(codeDir, "queries", "list_notes.ts"),
        `import { seed } from './countHelper.js';\n` +
          `export default async (): Promise<{ notes: number[] }> => ({ notes: [seed, seed + 1] });`
      );

      const wrote = await dispatcher.write({
        app: "demo",
        action: "add_note",
        input: { title: "hi" },
      });
      expect(wrote.isError).toBe(false);
      expect(wrote.structuredContent).toStrictEqual({ added: "HI" });

      const read = await dispatcher.read({ app: "demo", query: "list_notes" });
      expect(read.isError).toBe(false);
      expect(read.structuredContent).toStrictEqual({ notes: [3, 4] });
    }, 30_000);
  });

  describe("declared routing", () => {
    it("write runs a declared action and fires the change notification", async () => {
      const out = await dispatcher.write({
        app: "demo",
        action: "add_note",
        input: { title: "x" },
      });
      expect(out.isError).toBe(false);
      expect(out.structuredContent).toStrictEqual({ added: "x" });
      expect(notified).toStrictEqual(["demo"]);
    });

    it("read runs a declared query (and never notifies)", async () => {
      const out = await dispatcher.read({ app: "demo", query: "list_notes" });
      expect(out.isError).toBe(false);
      expect(out.structuredContent).toStrictEqual({ notes: [] });
      expect(notified).toStrictEqual([]);
    });

    it("input failing the declared JSON Schema is refused before the worker", async () => {
      const out = await dispatcher.write({
        app: "demo",
        action: "add_note",
        input: { nope: 1 },
      });
      expect(out.isError).toBe(true);
      // Narrows the result union so the code assertion below always runs.
      assert(out.isError);
      expect(out.structuredContent.code).toBe("INVALID_INPUT");
    });

    it("a query addressed through write surfaces WRONG_KIND", async () => {
      const out = await dispatcher.write({ app: "demo", action: "list_notes" });
      expect(out.isError).toBe(true);
      assert(out.isError);
      expect(out.structuredContent.code).toBe("WRONG_KIND");
    });

    it("describe returns the manifest — no schema payload, no silo", async () => {
      const out = await dispatcher.describe({ app: "demo" });
      expect(out.isError).toBe(false);
      const value = out.structuredContent as {
        manifest: { id: string };
        schema?: unknown;
      };
      expect(value.manifest.id).toBe("demo");
      expect("schema" in value).toBe(false);
    });

    it("the `_sql` builtin is gone: underscore names are unknown handlers", async () => {
      const write = await dispatcher.write({
        app: "demo",
        action: "_sql",
        input: { sql: "x" },
      });
      expect(write.isError).toBe(true);
      assert(write.isError);
      expect(write.structuredContent.code).toBe("UNKNOWN_ACTION");
      const read = await dispatcher.read({
        app: "demo",
        query: "_sql",
        input: { sql: "x" },
      });
      expect(read.isError).toBe(true);
      assert(read.isError);
      expect(read.structuredContent.code).toBe("UNKNOWN_QUERY");
    });

    it("unknown app / missing code dir map to their own error codes", async () => {
      const out = await dispatcher.write({ app: "ghost", action: "a" });
      expect(out.isError).toBe(true);
      assert(out.isError);
      expect(out.structuredContent.code).toBe("UNKNOWN_APP");
      const bare = new Dispatcher({ registry });
      const noCode = await bare.read({ app: "demo", query: "list_notes" });
      expect(noCode.isError).toBe(true);
      assert(noCode.isError);
      expect(noCode.structuredContent.code).toBe("NO_ACTIVE_VERSION");
    });
  });
});
