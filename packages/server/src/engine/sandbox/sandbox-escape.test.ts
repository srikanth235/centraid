// governance: allow-repo-hygiene file-size-limit (#865) every escape case runs a real hostile handler in a real worker; splitting the lanes would scatter the one enforcement story.
/**
 * ESCAPE TESTS for the handler sandbox (#842): every case runs a hostile
 * handler in a REAL worker through the REAL runner entry point and asserts the
 * refusal. Nothing here inspects the policy object — a test that only read the
 * policy would prove nothing about enforcement.
 *
 * The last block is a CHARACTERIZATION pin: what an automation worker with NO
 * parent-chosen lane can still reach today. Deliberately green — removing the
 * reach must be a diff, not a discovery.
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

/** Module scope, not `beforeAll`: each worker is terminated by the helper that
 * spawned it, and a hook-free suite cannot leak a hostile worker by forgetting
 * cleanup. */
const dir = tempDirSync("sandbox-escape-");

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
  sandbox?: {
    sandboxLane?: string;
    sandboxReadRoots?: string[];
    sandboxRuntimeDir?: string;
  }
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

  test("process.kill signal 0 still probes existence after F4 wrapping (#865)", async () => {
    // Node and Electron worker internals use kill(pid, 0) as a liveness
    // check. Revoking that along with SIGKILL hung the thread; the probe
    // must still return so a handler can post its result.
    const file = await handler(
      "kill-zero.mjs",
      `export default async () => {
         process.kill(process.pid, 0);
         return { alive: true };
       };`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({ alive: true });
  });

  test("process.kill and process.abort cannot take down the gateway (#865)", async () => {
    // Worker threads share the gateway's PID: a successful SIGKILL here would
    // end every lane at once, so the strongest assertion available is that this
    // result was posted AT ALL — the process survived both attempts.
    const file = await handler(
      "self-destruct.mjs",
      `export default async () => {
         const out = [];
         try { process.kill(process.pid, "SIGKILL"); out.push("kill:ALLOWED"); }
         catch (error) { out.push("kill:" + (error.code === "CENTRAID_SANDBOX_DENIED" ? "refused" : "other")); }
         try { process.abort(); out.push("abort:ALLOWED"); }
         catch (error) { out.push("abort:" + (error.code === "CENTRAID_SANDBOX_DENIED" ? "refused" : "other")); }
         return { denied: out.join(",") };
       };`
    );
    const result = await runAppHandler(file);
    expect(refusal(result)).toBe("kill:refused,abort:refused");
  });

  test("process.report.getReport() cannot read the real OS environ (#865)", async () => {
    // getReport reads environ at call time, past any frozen process.env. The
    // worker here genuinely carries CANARY_ENV in its OS environment — a
    // native report would leak it. The stub must stay callable (Electron
    // invokes it) and still post a result: throwing from getReport hung
    // handler workers so desktop writes never settled.
    const file = await handler(
      "diagnostic-report.mjs",
      `export default async () => {
         const report = process.report.getReport();
         const vars = report.environmentVariables ?? {};
         const written = process.report.writeReport();
         return {
           leakedCanary: vars.${CANARY_ENV} ?? null,
           leakedKeys: Object.keys(vars).length,
           written,
         };
       };`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(true);
    const value = result.value as {
      leakedCanary: string | null;
      leakedKeys: number;
      written: string;
    };
    expect(value.leakedCanary).toBeNull();
    expect(value.leakedKeys).toBe(0);
    expect(value.written).toBe("");
  });

  test("process.argv and process.execArgv are redacted in the handler thread (#865)", async () => {
    const file = await handler(
      "argv.mjs",
      `export default async () => ({
         argv: process.argv,
         execArgv: process.execArgv,
       });`
    );
    const result = await runAppHandler(file);
    expect(result.ok).toBe(true);
    const value = result.value as { argv: string[]; execArgv: string[] };
    expect(value.execArgv).toStrictEqual([]);
    // argv[0] is the worker binary (Electron reads it); nothing else, and
    // never the canary that would have ridden a later slot.
    expect(value.argv.length).toBeLessThanOrEqual(1);
    expect(value.argv.join("\0")).not.toContain(CANARY_VALUE);
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

/** sha256("centraid") prefix — asserted rather than recomputed so a broken
 * crypto import cannot make the test pass by agreeing with itself. */
function createHashPrefix(): string {
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
    // A real file outside the granted root — `/etc/hostname` is missing on
    // macOS, so realpath of the link threw ENOENT and the ancestor walk
    // treated the link's parent (inside the root) as the probe.
    const outside = path.join(path.dirname(dir), "sandbox-escape-outside.txt");
    await writeFile(outside, "leaked-secret");
    const link = path.join(dir, "escape-link");
    await symlink(outside, link);
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
   * An automation worker handed NO `sandboxLane` still gets the strict floor
   * (#846): the filesystem outside every root, subprocesses, and the
   * environment are all refused. A handler that needs more asks for it in its
   * manifest, where the ask is reviewable.
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
    const result = await runAutomationHandler(file);
    // The floor has no filesystem grant at all: the STATIC `node:fs` import is
    // refused at graph load, so the handler body never runs — nothing leaked.
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

  test("the host-planted runtime dir survives the environment revocation", async () => {
    /*
     * Why `sandboxRuntimeDir` exists (audit of #846 P9): every lane freezes
     * `process.env` BEFORE the handler graph loads, and the five recognition
     * bundles read `CENTRAID_AUTOMATION_RUNTIME_DIR` at module top level — the
     * freeze silently killed that override and pointed them at a `runtime/`
     * directory that exists only in the source tree. A path is not a
     * capability, so the host resolves it and plants it on `globalThis` before
     * installing the sandbox.
     */
    const file = await handler(
      "planted-runtime-dir.mjs",
      `export default async () => ({
         planted: globalThis.__centraidAutomationRuntimeDir,
         envIsEmpty: Object.keys(process.env).length === 0,
         envOverride: process.env.CENTRAID_AUTOMATION_RUNTIME_DIR ?? null,
       });`
    );
    const result = await runAutomationHandler(file, {
      sandboxRuntimeDir: "/opt/centraid-runtime",
    });
    expect(result.ok).toBe(true);
    expect(result.value).toStrictEqual({
      planted: "/opt/centraid-runtime",
      envIsEmpty: true,
      envOverride: null,
    });
  });
});
