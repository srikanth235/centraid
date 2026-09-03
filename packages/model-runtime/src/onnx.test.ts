import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  resolveRuntimeEntry,
  resolveRuntimeModule,
  RuntimeNotInstalledError,
} from "./onnx.js";

const absentRuntime = path.join(
  import.meta.dirname,
  "fixtures",
  "absent-runtime"
);

function installPackage(
  runtimeDir: string,
  specifier: string,
  manifest: Record<string, unknown>,
  files: readonly string[]
): string {
  const packageDir = path.join(
    runtimeDir,
    "node_modules",
    ...specifier.split("/")
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(manifest)
  );
  for (const file of files) {
    const target = path.join(packageDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "module.exports = {};\n");
  }
  return packageDir;
}

describe(resolveRuntimeModule, () => {
  it("throws a RuntimeNotInstalledError with a clear 'run setup first' message when runtime/ has no node_modules", () => {
    expect(() =>
      resolveRuntimeModule("onnxruntime-node", absentRuntime)
    ).toThrow(RuntimeNotInstalledError);
    expect(() =>
      resolveRuntimeModule("onnxruntime-node", absentRuntime)
    ).toThrow(/run.*setup/iu);
  });

  it("throws the same actionable error when the tree exists but the package does not", () => {
    const runtimeDir = tempDirSync("model-runtime-resolve-");
    mkdirSync(path.join(runtimeDir, "node_modules"), { recursive: true });
    expect(() => resolveRuntimeModule("onnxruntime-node", runtimeDir)).toThrow(
      RuntimeNotInstalledError
    );
  });

  it("resolves a scoped specifier as two path segments", () => {
    const runtimeDir = tempDirSync("model-runtime-resolve-");
    const dir = installPackage(
      runtimeDir,
      "@ffmpeg-installer/ffmpeg",
      { main: "index.js" },
      ["index.js"]
    );
    expect(resolveRuntimeModule("@ffmpeg-installer/ffmpeg", runtimeDir)).toBe(
      path.join(dir, "index.js")
    );
  });
});

describe(resolveRuntimeEntry, () => {
  it("prefers exports['.'] over main", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "pkg",
      { exports: { ".": "./dist/exported.js" }, main: "./dist/legacy.js" },
      ["dist/exported.js", "dist/legacy.js"]
    );
    expect(resolveRuntimeEntry(dir)).toBe(
      path.join(dir, "dist", "exported.js")
    );
  });

  it("walks the require/node/default conditions in that order", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "conditional",
      {
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            require: "./dist/cjs.js",
            default: "./dist/esm.js",
          },
        },
      },
      ["dist/cjs.js", "dist/esm.js"]
    );
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "dist", "cjs.js"));
  });

  it("reads a bare condition map as the '.' target", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "bare-conditions",
      { exports: { require: "./lib/main.js", default: "./lib/mod.mjs" } },
      ["lib/main.js", "lib/mod.mjs"]
    );
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "lib", "main.js"));
  });

  it("skips an exports target the install did not produce and falls back", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "partial",
      { exports: { ".": "./dist/missing.js" }, main: "./dist/real.js" },
      ["dist/real.js"]
    );
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "dist", "real.js"));
  });

  it("treats a main naming a directory as that directory's index.js", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(runtimeDir, "dirmain", { main: "./lib" }, [
      "lib/index.js",
    ]);
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "lib", "index.js"));
  });

  it("falls back to index.js when the manifest names no entry", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(runtimeDir, "plain", { version: "1.0.0" }, [
      "index.js",
    ]);
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "index.js"));
  });

  it("returns null for a directory that does not exist and for one with no entry", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    expect(resolveRuntimeEntry(path.join(runtimeDir, "nope"))).toBeNull();
    const dir = installPackage(runtimeDir, "empty", { main: "./gone.js" }, []);
    expect(resolveRuntimeEntry(dir)).toBeNull();
  });

  it("falls back past a main naming a directory that holds no entry", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(runtimeDir, "emptydir", { main: "./lib" }, [
      "lib/.keep",
      "index.js",
    ]);
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "index.js"));
  });

  it("resolves a main naming a directory through that directory's package.json", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(runtimeDir, "nested", { main: "./lib" }, [
      "lib/entry.js",
    ]);
    writeFileSync(
      path.join(dir, "lib", "package.json"),
      JSON.stringify({ main: "./entry.js" })
    );
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "lib", "entry.js"));
  });

  it("applies CommonJS extension search to an extensionless main", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "extensionless",
      { main: "./lib/index" },
      ["lib/index.js"]
    );
    expect(resolveRuntimeEntry(dir)).toBe(path.join(dir, "lib", "index.js"));
  });

  it("resolves the shape onnxruntime-node actually publishes", () => {
    const runtimeDir = tempDirSync("model-runtime-entry-");
    const dir = installPackage(
      runtimeDir,
      "onnxruntime-node",
      { name: "onnxruntime-node", main: "dist/index.js" },
      ["dist/index.js", "bin/napi-v6/linux/x64/onnxruntime_binding.node"]
    );
    expect(resolveRuntimeModule("onnxruntime-node", runtimeDir)).toBe(
      path.join(dir, "dist", "index.js")
    );
  });
});
