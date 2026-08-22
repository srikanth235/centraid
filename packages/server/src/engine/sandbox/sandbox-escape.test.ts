/**
 * ESCAPE TESTS for the handler sandbox (issue #842 W7.1).
 *
 * Every case here runs a genuinely hostile handler in a REAL worker thread
 * driven by the REAL runner entry point and asserts the refusal. A test that
 * only inspected the policy object would prove nothing about enforcement, so
 * nothing in this file inspects the policy: it opens files, opens sockets,
 * spawns processes, and reads the environment, and it fails if any of that
 * succeeds.
 *
 * The last block is the opposite: a CHARACTERIZATION pin recording what an
 * automation worker running with NO parent-chosen lane can still reach today.
 * It is deliberately green — its job is to make the residual reach visible and
 * make removing it a diff, not a discovery.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

const APP_RUNNER = fileURLToPath(
  new URL("../worker/runner.ts", import.meta.url)
);
const AUTOMATION_RUNNER = fileURLToPath(
  new URL("../../automation/worker/runner.ts", import.meta.url)
);

/** Seeded into the worker's environment so "env is empty" is a real assertion. */
const CANARY_ENV = "CENTRAID_SANDBOX_CANARY";
const CANARY_VALUE = "canary-value-that-must-not-be-readable";

/**
 * Created eagerly at module scope rather than in a `beforeAll`: every worker in
 * this file is owned and terminated by the helper that spawned it, so the file
 * needs no lifecycle hooks at all — and a hook-free suite cannot leak a hostile
 * worker into a later test by forgetting to clean up.
 */
const dir = tempDirSync("sandbox-escape-");

/** Write one handler module and return its absolute path. */
async function handler(name: string, source: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, source);
  return file;
}

interface ResultMessage {
  type?: string;
  ok?: boolean;
  value?: unknown;
  error?: string;
}

function awaitResult(worker: Worker, ms = 20_000): Promise<ResultMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for the worker result")),
      ms
    );
    worker.on("message", (msg: ResultMessage) => {
      if (msg?.type !== "result") return;
      clearTimeout(timer);
      resolve(msg);
    });
    worker.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Run one handler through the real app-handler worker entry point. */
async function runAppHandler(handlerFile: string): Promise<ResultMessage> {
  const worker = new Worker(APP_RUNNER, {
    workerData: { handlerFile, handlerKind: "query", args: { body: {} } },
    // Matches worker/runner.test.ts: vitest's own execArgv is not valid for a
    // freshly spawned worker.
    execArgv: [],
    env: { [CANARY_ENV]: CANARY_VALUE },
  });
  try {
    return await awaitResult(worker);
  } finally {
    await worker.terminate();
  }
}

/** Run one handler through the real automation worker entry point. */
async function runAutomationHandler(
  handlerFile: string,
  sandbox?: { sandboxLane: string; sandboxReadRoots?: string[] }
): Promise<ResultMessage> {
  const worker = new Worker(AUTOMATION_RUNNER, {
    workerData: {
      handlerFile,
      args: {},
      now: "2026-08-21T00:00:00.000Z",
      ...sandbox,
    },
    execArgv: [],
    env: { [CANARY_ENV]: CANARY_VALUE },
  });
  try {
    return await awaitResult(worker);
  } finally {
    await worker.terminate();
  }
}

/** The refusal text, wherever the runner surfaced it. */
function refusal(result: ResultMessage): string {
  if (result.ok === false) return String(result.error ?? "");
  const value = result.value as { denied?: unknown } | undefined;
  return String(value?.denied ?? JSON.stringify(result.value));
}

describe("app-handler lane: filesystem", () => {
  test("import of node:fs is refused before the handler ever runs", async () => {
    const file = await handler(
      "fs-import.mjs",
      `import { readFileSync } from "node:fs";
       export default async () => ({ leaked: readFileSync("/etc/hostname", "utf8") });`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain("sandbox refused");
    expect(refusal(result)).toContain("node:fs");
  });

  test("process.getBuiltinModule('fs') — the documented loader bypass — is refused", async () => {
    const file = await handler(
      "fs-bypass.mjs",
      `export default async () => {
         try {
           const fs = process.getBuiltinModule("fs");
           return { leaked: fs.readFileSync("/etc/hostname", "utf8") };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { leaked?: string; denied?: string };
    expect(value.leaked).toBeUndefined();
    expect(value.denied).toContain("getBuiltinModule");
  });

  test("a CommonJS dependency's require('fs') is refused too", async () => {
    // registerHooks (not register) is why this case passes: the async loader
    // hooks never see a CJS require, so a hostile transitive dependency would
    // have walked straight out.
    await handler(
      "cjs-dep.cjs",
      `const fs = require("node:fs");
       module.exports = { read: () => fs.readFileSync("/etc/hostname", "utf8") };`
    );
    const file = await handler(
      "cjs-host.mjs",
      `import dep from "./cjs-dep.cjs";
       export default async () => ({ leaked: dep.read() });`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain("sandbox refused");
  });

  test("node:module is refused, so createRequire cannot rebuild the loader", async () => {
    const file = await handler(
      "create-require.mjs",
      `export default async () => {
         try {
           const { createRequire } = await import("node:module");
           const require = createRequire(import.meta.url);
           return { leaked: require("node:fs").readFileSync("/etc/hostname", "utf8") };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { leaked?: string; denied?: string };
    expect(value.leaked).toBeUndefined();
    expect(value.denied).toContain("node:module");
  });

  test("taint follows a data: URL, so an eval-shaped import is confined", async () => {
    const file = await handler(
      "data-url.mjs",
      `export default async () => {
         try {
           const mod = await import("data:text/javascript," + encodeURIComponent(
             'export const read = async () => (await import("node:fs")).readFileSync("/etc/hostname","utf8");'
           ));
           return { leaked: await mod.read() };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { leaked?: string; denied?: string };
    expect(value.leaked).toBeUndefined();
    expect(value.denied).toContain("sandbox refused");
  });
});

describe("app-handler lane: network", () => {
  test("node:net is refused, so a raw socket cannot be opened", async () => {
    const file = await handler(
      "net-import.mjs",
      `export default async () => {
         try {
           const net = await import("node:net");
           net.createConnection({ host: "127.0.0.1", port: 9 });
           return { opened: true };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { opened?: boolean; denied?: string };
    expect(value.opened).toBeUndefined();
    expect(value.denied).toContain("node:net");
  });

  test("node:http and node:https are refused", async () => {
    const file = await handler(
      "http-import.mjs",
      `export default async () => {
         const denied = [];
         for (const id of ["node:http", "node:https", "node:dgram", "node:tls"]) {
           try { await import(id); denied.push(id + ":ALLOWED"); }
           catch (error) { denied.push(id + ":refused"); }
         }
         return { denied: denied.join(",") };
       };`
    );
    const result = await runAppHandler(file);
    expect(refusal(result)).toBe(
      "node:http:refused,node:https:refused,node:dgram:refused,node:tls:refused"
    );
  });

  test("the ambient global fetch is revoked", async () => {
    const file = await handler(
      "fetch-global.mjs",
      `export default async () => {
         try {
           await fetch("http://127.0.0.1:9/");
           return { reached: true };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { reached?: boolean; denied?: string };
    expect(value.reached).toBeUndefined();
    expect(value.denied).toContain("revoked");
  });

  test("the governed ctx.fetch capability still works after revocation", async () => {
    // The point of revoking the global is to turn network reach into a
    // capability, not to remove it. If this regressed to "denied" the sandbox
    // would be breaking the product rather than containing it.
    const file = await handler(
      "ctx-fetch.mjs",
      `export default async ({ ctx }) => ({ kind: typeof ctx.fetch });`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(true);
    expect((result.value as { kind: string }).kind).toBe("function");
  });
});

describe("app-handler lane: process", () => {
  test("node:child_process is refused, so no subprocess can be spawned", async () => {
    const file = await handler(
      "spawn.mjs",
      `export default async () => {
         try {
           const cp = await import("node:child_process");
           return { spawned: cp.execSync("id").toString() };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { spawned?: string; denied?: string };
    expect(value.spawned).toBeUndefined();
    expect(value.denied).toContain("node:child_process");
  });

  test("node:worker_threads is refused, so no unsandboxed sibling thread", async () => {
    const file = await handler(
      "sibling-thread.mjs",
      `export default async () => {
         try {
           await import("node:worker_threads");
           return { spawned: true };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAppHandler(file);
    const value = result.value as { spawned?: boolean; denied?: string };
    expect(value.spawned).toBeUndefined();
    expect(value.denied).toContain("node:worker_threads");
  });

  test("process.binding and process.dlopen are revoked", async () => {
    const file = await handler(
      "native.mjs",
      `export default async () => {
         const out = [];
         try { process.binding("fs"); out.push("binding:ALLOWED"); }
         catch (error) { out.push("binding:refused"); }
         try { process.dlopen({ exports: {} }, "/tmp/nope.node"); out.push("dlopen:ALLOWED"); }
         catch (error) { out.push("dlopen:" + (error.code === "CENTRAID_SANDBOX_DENIED" ? "refused" : "other")); }
         return { denied: out.join(",") };
       };`
    );
    const result = await runAppHandler(file);
    expect(refusal(result)).toBe("binding:refused,dlopen:refused");
  });

  test("the seeded environment secret is not readable from a handler", async () => {
    const file = await handler(
      "env.mjs",
      `export default async () => ({
         canary: process.env.${CANARY_ENV} ?? null,
         keys: Object.keys(process.env).length,
       });`
    );
    const result = await runAppHandler(file);
    const value = result.value as { canary: string | null; keys: number };
    expect(value.canary).toBeNull();
    expect(value.keys).toBe(0);
  });
});

describe("app-handler lane: the allowlist is not a blanket ban", () => {
  test("a handler using only computational builtins runs normally", async () => {
    const file = await handler(
      "benign.mjs",
      `import path from "node:path";
       import { createHash } from "node:crypto";
       export default async () => ({
         joined: path.posix.join("a", "b"),
         digest: createHash("sha256").update("centraid").digest("hex").slice(0, 8),
       });`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({
      joined: "a/b",
      digest: createHashPrefix(),
    });
  });
});

/** Fixed expected digest prefix — computed here so the test stays hermetic. */
function createHashPrefix(): string {
  // sha256("centraid") — asserted rather than recomputed so a broken crypto
  // import cannot make the test pass by agreeing with itself.
  return "bbec0fe3";
}

describe("automation lane: strict containment when the parent selects it", () => {
  test("node:fs is refused for an automation handler on the strict lane", async () => {
    const file = await handler(
      "automation-fs.mjs",
      `export default async () => {
         try {
           const fs = await import("node:fs");
           return { leaked: fs.readFileSync("/etc/hostname", "utf8") };
         } catch (error) { return { denied: error.message }; }
       };`
    );
    const result = await runAutomationHandler(file, {
      sandboxLane: "automation-handler",
    });
    const value = result.value as { leaked?: string; denied?: string };
    expect(value.leaked).toBeUndefined();
    expect(value.denied).toContain("node:fs");
  });

  test("network and subprocess are refused on the strict lane", async () => {
    const file = await handler(
      "automation-reach.mjs",
      `export default async () => {
         const out = [];
         for (const id of ["node:net", "node:child_process"]) {
           try { await import(id); out.push(id + ":ALLOWED"); }
           catch { out.push(id + ":refused"); }
         }
         try { await fetch("http://127.0.0.1:9/"); out.push("fetch:ALLOWED"); }
         catch { out.push("fetch:refused"); }
         return { denied: out.join(",") };
       };`
    );
    const result = await runAutomationHandler(file, {
      sandboxLane: "automation-handler",
    });
    expect(refusal(result)).toBe(
      "node:net:refused,node:child_process:refused,fetch:refused"
    );
  });
});

describe("automation lane: model-runtime read confinement", () => {
  test("a read inside the granted root succeeds and one outside is refused", async () => {
    const allowed = path.join(dir, "weights.bin");
    await writeFile(allowed, "model-bytes");
    const file = await handler(
      "confined-read.mjs",
      `import { readFileSync } from "node:fs";
       export default async ({ ctx }) => {
         const out = {};
         out.inside = readFileSync(${JSON.stringify(allowed)}, "utf8");
         try {
           out.outside = readFileSync("/etc/hostname", "utf8");
         } catch (error) { out.outsideDenied = error.code ?? error.message; }
         return out;
       };`
    );
    const result = await runAutomationHandler(file, {
      sandboxLane: "model-runtime",
      sandboxReadRoots: [dir],
    });
    const value = result.value as Record<string, string | undefined>;
    expect(value.inside).toBe("model-bytes");
    expect(value.outside).toBeUndefined();
    expect(value.outsideDenied).toBe("CENTRAID_SANDBOX_FS_DENIED");
  });

  test("the confined mirror refuses writes even inside the granted root", async () => {
    const target = path.join(dir, "should-not-appear.txt");
    const file = await handler(
      "confined-write.mjs",
      `import { writeFileSync } from "node:fs";
       export default async () => {
         try {
           writeFileSync(${JSON.stringify(target)}, "written");
           return { wrote: true };
         } catch (error) { return { denied: error.code ?? error.message }; }
       };`
    );
    const result = await runAutomationHandler(file, {
      sandboxLane: "model-runtime",
      sandboxReadRoots: [dir],
    });
    const value = result.value as { wrote?: boolean; denied?: string };
    expect(value.wrote).toBeUndefined();
    expect(value.denied).toBe("CENTRAID_SANDBOX_FS_WRITE_DENIED");
  });

  test("a symlink planted inside the root cannot be followed out of it", async () => {
    const { symlink } = await import("node:fs/promises");
    const link = path.join(dir, "escape-link");
    await symlink("/etc/hostname", link);
    const file = await handler(
      "symlink-escape.mjs",
      `import { readFileSync } from "node:fs";
       export default async () => {
         try { return { leaked: readFileSync(${JSON.stringify(link)}, "utf8") }; }
         catch (error) { return { denied: error.code ?? error.message }; }
       };`
    );
    const result = await runAutomationHandler(file, {
      sandboxLane: "model-runtime",
      sandboxReadRoots: [dir],
    });
    const value = result.value as { leaked?: string; denied?: string };
    expect(value.leaked).toBeUndefined();
    expect(value.denied).toBe("CENTRAID_SANDBOX_FS_DENIED");
  });
});

describe("an automation worker given no lane gets the strict floor", () => {
  /*
   * This replaces the CHARACTERIZATION block that stood here (#846 P9).
   *
   * That block pinned what an automation worker could still reach when
   * `automation/worker/runner.ts` was handed no `sandboxLane`: the filesystem
   * outside any root, subprocesses, and the environment. It was today's
   * default and it contradicted SECURITY.md's "app handlers are
   * consent-scoped" framing for the automation plane — consent scopes the
   * `ctx` rails, and an unsandboxed handler does not have to use them.
   *
   * The reason it stood was one builtin. The ONNX recognition bundles resolved
   * `runtime/node_modules` through `node:module`'s `createRequire`, which every
   * lane refuses (correctly — a `createRequire` in the graph resolves through
   * Node's own loader and skips these hooks), so no recognition automation
   * could run under any lane and the plane ran everything under none.
   * `packages/model-runtime/src/onnx.ts` no longer needs it, so the floor now
   * applies to every handler and one that needs more asks for it in its
   * manifest, where the ask is reviewable.
   *
   * Deleting the pin without these assertions would have erased the record.
   * These are the refusal assertions it promised in its place.
   */
  test("reads outside every root are refused with no lane requested", async () => {
    const file = await handler(
      "floor-fs.mjs",
      `import { readFileSync } from "node:fs";
       export default async () => {
         try { return { leaked: readFileSync("/etc/hostname", "utf8") }; }
         catch (error) { return { denied: error.code ?? error.message }; }
       };`
    );
    // No sandboxLane, which is exactly the shape the pin characterised.
    const result = await runAutomationHandler(file);
    // Stronger than a caught error: the floor has no filesystem grant at all,
    // so the STATIC `node:fs` import is refused while the module graph loads
    // and the handler body never runs. Nothing is leaked because nothing ran.
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(String(result.error)).toMatch(/filesystem grant|node:fs/u);
  });

  test("subprocesses are refused with no lane requested", async () => {
    const file = await handler(
      "floor-spawn.mjs",
      `export default async () => {
         try {
           const { execSync } = await import("node:child_process");
           return { spawned: execSync("echo ok").toString().trim() };
         } catch (error) { return { denied: error.code ?? error.message }; }
       };`
    );
    const result = await runAutomationHandler(file);
    const value = result.value as { spawned?: string; denied?: string };
    expect(value.spawned).toBeUndefined();
    expect(value.denied).toBeDefined();
  });

  test("the environment is empty with no lane requested", async () => {
    const file = await handler(
      "floor-env.mjs",
      `export default async () => ({
         readEnvSecret: process.env.${CANARY_ENV} === ${JSON.stringify(CANARY_VALUE)},
         envKeys: Object.keys(process.env).length,
       });`
    );
    const result = await runAutomationHandler(file);
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({
      readEnvSecret: false,
      envKeys: 0,
    });
  });
});
