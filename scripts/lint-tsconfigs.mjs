#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ROOTS = ["packages", "apps"];
const REMOVED_MODULE_RESOLUTIONS = new Set(["node", "node10", "classic"]);

function readJsonc(file, root = ROOT) {
  const result = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(
      result.error.messageText,
      "\n"
    );
    throw new Error(`${path.relative(root, file)}: ${message}`);
  }
  return result.config;
}

function workspaceDirs(root) {
  return WORKSPACE_ROOTS.flatMap((workspaceRoot) => {
    const dir = path.join(root, workspaceRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  });
}

function tsconfigs(dir) {
  return readdirSync(dir)
    .filter((name) => /^tsconfig(?:\.[\w-]+)?\.json$/u.test(name))
    .map((name) => path.join(dir, name));
}

function sourceTests(dir) {
  const src = path.join(dir, "src");
  if (!existsSync(src)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name))
        files.push(file);
    }
  };
  walk(src);
  return files;
}

function parsedConfig(file, json) {
  return ts.parseJsonConfigFileContent(
    json,
    ts.sys,
    path.dirname(file),
    undefined,
    file
  );
}

function includesTests(parsed, tests) {
  const files = new Set(parsed.fileNames.map((file) => path.resolve(file)));
  return tests.every((file) => files.has(file));
}

export function lintTsconfigs(root = ROOT) {
  const failures = [];
  for (const workspace of workspaceDirs(root)) {
    const rel = path.relative(root, workspace);
    const configs = tsconfigs(workspace);
    const byName = new Map(configs.map((file) => [path.basename(file), file]));

    for (const file of configs) {
      const json = readJsonc(file, root);
      const configRel = path.relative(root, file);
      const compilerOptions = json.compilerOptions ?? {};

      if (typeof json.extends !== "string" || json.extends.length === 0) {
        failures.push(`${configRel}: must extend a shared tsconfig base`);
      }
      if (compilerOptions.baseUrl !== undefined) {
        failures.push(`${configRel}: baseUrl is removed by TypeScript 7`);
      }
      if (
        typeof compilerOptions.moduleResolution === "string" &&
        REMOVED_MODULE_RESOLUTIONS.has(
          compilerOptions.moduleResolution.toLowerCase()
        )
      ) {
        failures.push(
          `${configRel}: moduleResolution ${compilerOptions.moduleResolution} is removed by TypeScript 7`
        );
      }
    }

    const mainConfig = byName.get("tsconfig.json");
    if (!mainConfig) continue;
    const mainJson = readJsonc(mainConfig, root);
    const mainParsed = parsedConfig(mainConfig, mainJson);
    const tests = sourceTests(workspace);
    const testConfig = byName.get("tsconfig.test.json");
    const packageJson = path.join(workspace, "package.json");
    const typecheck = existsSync(packageJson)
      ? (readJsonc(packageJson, root).scripts?.typecheck ?? "")
      : "";

    if (!mainParsed.options.noEmit) {
      const excludesTests = !includesTests(mainParsed, tests);
      if (tests.length > 0 && !excludesTests) {
        failures.push(
          `${rel}/tsconfig.json: emitting programs must exclude source tests`
        );
      }
      if (tests.length > 0 && !testConfig) {
        failures.push(`${rel}: source tests need a tsconfig.test.json program`);
      }
    }

    if (testConfig) {
      const parsed = parsedConfig(testConfig, readJsonc(testConfig, root));
      if (!includesTests(parsed, tests)) {
        failures.push(
          `${path.relative(root, testConfig)}: must include every source test`
        );
      }
      if (!typecheck.includes("tsconfig.test.json")) {
        failures.push(
          `${rel}/package.json: typecheck must target tsconfig.test.json`
        );
      }
    }
  }
  return failures;
}

function main() {
  const failures = lintTsconfigs();
  if (failures.length > 0) {
    process.stderr.write(
      `tsconfig topology failures:\n${failures.join("\n")}\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    "tsconfigs: ok (base inheritance, TS7 options, emit/test coverage)\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
