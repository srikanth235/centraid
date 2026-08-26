/**
 * Unit tests for the sandbox RULING (issue #842 W7.1). These prove the
 * decision function says the right thing; they prove nothing about whether the
 * decision is enforced. Enforcement is `sandbox-escape.test.ts`, which runs
 * hostile handlers in real worker threads and asserts the refusals.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  appHandlerPolicy,
  appSeedPolicy,
  automationHandlerPolicy,
  builtinDecision,
  builtinId,
  COMPUTATIONAL_BUILTINS,
  isPathWithinRoots,
  modelRuntimePolicy,
  normalizeRoots,
} from "./policy.js";

describe("builtin specifier recognition", () => {
  test("recognizes both spellings and rejects userland lookalikes", () => {
    expect(builtinId("node:fs")).toBe("fs");
    expect(builtinId("fs")).toBe("fs");
    expect(builtinId("node:fs/promises")).toBe("fs/promises");
    // A userland package whose name merely starts like a builtin must not be
    // mistaken for one, or the allowlist would refuse innocent dependencies.
    expect(builtinId("crypto-js")).toBeNull();
    expect(builtinId("./local.js")).toBeNull();
    expect(builtinId("/abs/path.js")).toBeNull();
    expect(builtinId("")).toBeNull();
  });
});

describe("app-handler lane", () => {
  const policy = appHandlerPolicy();

  test("refuses every builtin that carries ambient authority", () => {
    for (const id of [
      "fs",
      "fs/promises",
      "child_process",
      "net",
      "tls",
      "http",
      "https",
      "dgram",
      "dns",
      "module",
      "process",
      "os",
      "vm",
      "v8",
      "worker_threads",
      "cluster",
      "inspector",
      "repl",
      "perf_hooks",
    ]) {
      expect(builtinDecision(policy, id).kind, `node:${id}`).not.toBe("allow");
    }
  });

  test("allows the computational floor so real handlers still work", () => {
    for (const id of COMPUTATIONAL_BUILTINS) {
      expect(builtinDecision(policy, id).kind, `node:${id}`).toBe("allow");
    }
  });

  test("names the lane in the refusal so a failing handler is diagnosable", () => {
    const decision = builtinDecision(policy, "child_process");
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error("unreachable");
    expect(decision.reason).toContain("child_process");
    expect(decision.reason).toContain("app-handler");
  });

  test("grants no filesystem at all, not even a confined mirror", () => {
    expect(builtinDecision(policy, "fs").kind).toBe("deny");
    expect(policy.filesystem).toBe("denied");
    expect(policy.nativeAddons).toBe(false);
    expect(policy.environment).toBe("denied");
  });
});

describe("automation-handler lane", () => {
  test("is as strict as the app-handler lane and is a separate object", () => {
    const automation = automationHandlerPolicy();
    const app = appHandlerPolicy();
    expect(automation.filesystem).toBe("denied");
    expect(automation.nativeAddons).toBe(false);
    expect(automation.allowedBuiltins).toStrictEqual(app.allowedBuiltins);
    // Separate lanes: widening one must never silently widen the other.
    expect(automation.lane).not.toBe(app.lane);
  });
});

describe("app-seed lane", () => {
  const appDir = path.resolve("/tmp/centraid-sandbox-roots/apps/photos");
  const policy = appSeedPolicy(appDir);

  // The regression this lane exists for: photos/seed.js reads its bundled
  // sample images with readFileSync, and the app-handler lane refused `fs`
  // outright, so demo seeding died with "lane app-handler has no filesystem
  // grant". Revert the runner to appHandlerPolicy for seeds and this fails.
  test("grants fs, confined to the seed's own app directory", () => {
    expect(policy.filesystem).toStrictEqual({
      mode: "read-confined",
      readRoots: [appDir],
    });
    expect(builtinDecision(policy, "fs").kind).not.toBe("refused");
    expect(builtinDecision(policy, "fs/promises").kind).not.toBe("refused");
  });

  test("is otherwise exactly the app-handler floor, and a separate lane", () => {
    const app = appHandlerPolicy();
    expect(policy.network).toBe("denied");
    expect(policy.subprocess).toBe("denied");
    expect(policy.environment).toBe("denied");
    // No native addons: a seed reads files, it does not load binaries.
    expect(policy.nativeAddons).toBe(false);
    // The ONLY widening over the handler lane is the two fs ids.
    expect([...policy.allowedBuiltins].sort()).toStrictEqual(
      [...app.allowedBuiltins, "fs", "fs/promises"].sort()
    );
    // Separate lanes: restoring what a seed needs must never widen handlers.
    expect(policy.lane).not.toBe(app.lane);
    expect(app.filesystem).toBe("denied");
  });

  test("refuses a read outside the seed's own directory", () => {
    const sibling = path.resolve("/tmp/centraid-sandbox-roots/apps/notes");
    const grant = policy.filesystem as { readRoots: readonly string[] };
    expect(grant.readRoots).not.toContain(sibling);
    expect(grant.readRoots).toHaveLength(1);
  });
});

describe("model-runtime lane", () => {
  const roots = [path.resolve("/tmp/centraid-sandbox-roots/models")];
  const policy = modelRuntimePolicy(roots);

  test("routes fs through the confined mirror rather than the real builtin", () => {
    expect(builtinDecision(policy, "fs")).toStrictEqual({
      kind: "confined-fs",
      promises: false,
    });
    expect(builtinDecision(policy, "fs/promises")).toStrictEqual({
      kind: "confined-fs",
      promises: true,
    });
  });

  test("still refuses sockets and subprocesses despite the fs grant", () => {
    for (const id of ["net", "http", "https", "child_process", "module"]) {
      expect(builtinDecision(policy, id).kind, `node:${id}`).toBe("deny");
    }
  });

  test("declares its native-addon hole rather than hiding it", () => {
    // Not an accident: the lane loads onnxruntime-node, and a .node binary is
    // outside every check the sandbox makes. The test exists so the hole can
    // only be widened deliberately.
    expect(policy.nativeAddons).toBe(true);
  });
});

describe("read-root normalization", () => {
  test("absolutizes, de-duplicates and sorts; drops empty entries", () => {
    const result = normalizeRoots(["/b/two", "/a/one", "/b/two", "   ", ""]);
    expect(result).toStrictEqual([
      path.resolve("/a/one"),
      path.resolve("/b/two"),
    ]);
  });

  test("realpath aliases of the same directory collapse to one root", () => {
    const dir = tempDirSync("sandbox-root-");
    const canonical = realpathSync(dir);
    const roots = normalizeRoots([dir, canonical]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(canonical);
    expect(isPathWithinRoots(path.join(canonical, "weights.bin"), roots)).toBe(
      true
    );
  });
});

describe("root containment", () => {
  const roots = normalizeRoots(["/srv/models"]);

  test("accepts the root itself and paths beneath it", () => {
    expect(isPathWithinRoots("/srv/models", roots)).toBe(true);
    expect(isPathWithinRoots("/srv/models/ocr/weights.onnx", roots)).toBe(true);
  });

  test("refuses siblings whose name merely shares the root's prefix", () => {
    // The classic off-by-one: a naive startsWith would accept this.
    expect(isPathWithinRoots("/srv/models-evil/secret", roots)).toBe(false);
  });

  test("refuses traversal out of the root", () => {
    expect(isPathWithinRoots("/srv/models/../../etc/passwd", roots)).toBe(
      false
    );
  });

  test("a bare filesystem root really does contain everything", () => {
    // Regression: the string form `resolved.startsWith(root + sep)` compares
    // against "//" for a "/" root and matches nothing, so a lane granted the
    // whole filesystem would silently have refused every read.
    expect(isPathWithinRoots("/etc/hostname", normalizeRoots(["/"]))).toBe(
      true
    );
  });

  test("refuses everything when no root was granted", () => {
    expect(isPathWithinRoots("/srv/models", [])).toBe(false);
    expect(isPathWithinRoots("/", [])).toBe(false);
  });
});
