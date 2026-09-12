#!/usr/bin/env node
// TypeScript program topology guard (issue #619).
//
// Typecheck is only meaningful when every source and test file belongs to a
// program, and emitted libraries must never package their own tests. This
// catches the structural configuration regressions that ordinary `tsc` calls
// cannot see: a green source-only program says nothing about excluded tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ROOTS = ["packages", "apps"];
const REMOVED_MODULE_RESOLUTIONS = new Set(["node", "node10", "classic"]);
const NODE_TOOLING_PROFILE = "tsconfig.node.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RootToolingProgram = {
  rel: string;
  requiredWhen?: string;
  extendsNeedle: string;
  typecheckNeedles: string[];
};

/** Root programs that are not turbo workspaces (#1018). */
const ROOT_TOOLING_PROGRAMS: RootToolingProgram[] = [
  {
    rel: "scripts/tsconfig.json",
    extendsNeedle: NODE_TOOLING_PROFILE,
    typecheckNeedles: ["tsc -p scripts"],
  },
  {
    rel: "scripts/tsconfig.pricing.json",
    requiredWhen: "scripts/refresh-pricing-snapshot.ts",
    extendsNeedle: "tsconfig.base.json",
    typecheckNeedles: ["tsc -p scripts/tsconfig.pricing.json"],
  },
  {
    rel: "scripts/tsconfig.design.json",
    requiredWhen: "scripts/site-tokens.ts",
    extendsNeedle: "tsconfig.base.json",
    typecheckNeedles: ["tsc -p scripts/tsconfig.design.json"],
  },
  {
    rel: "scripts/tsconfig.tool-configs.json",
    requiredWhen: "astro.config.ts",
    extendsNeedle: "tsconfig.base.json",
    typecheckNeedles: ["tsc -p scripts/tsconfig.tool-configs.json"],
  },
  {
    rel: "tests/tsconfig.agent-e2e.json",
    requiredWhen: "tests/agent-e2e-shared/harness.ts",
    extendsNeedle: NODE_TOOLING_PROFILE,
    typecheckNeedles: ["tsc -p tests/tsconfig.agent-e2e.json"],
  },
];

function typecheckMentions(script: string, needle: string): boolean {
  if (needle === "tsc -p scripts" || needle === "tsc -p tests") {
    return new RegExp(
      `(?:^|[\\s;&])${needle.replaceAll(" ", "\\s+")}(?:\\s|$|&|;)`,
      "u"
    ).test(script);
  }
  return script.includes(needle);
}

function reportRemovedModuleResolution(
  failures: string[],
  rel: string,
  compilerOptions: Record<string, unknown>
): void {
  const moduleResolution = compilerOptions.moduleResolution;
  if (
    typeof moduleResolution === "string" &&
    REMOVED_MODULE_RESOLUTIONS.has(moduleResolution.toLowerCase())
  ) {
    failures.push(
      `${rel}: moduleResolution ${moduleResolution} is removed by TypeScript 7`
    );
  }
}

function lintRootTooling(root: string, failures: string[]): void {
  const packageJson = path.join(root, "package.json");
  if (!existsSync(packageJson)) return;
  const pkg = readJsonc(packageJson, root);
  const scriptsValue = pkg.scripts;
  const scripts = isRecord(scriptsValue) ? scriptsValue : {};
  const typecheck =
    typeof scripts.typecheck === "string" ? scripts.typecheck : "";
  const affected =
    typeof scripts["typecheck:affected"] === "string"
      ? scripts["typecheck:affected"]
      : "";
  if (typeof typecheck !== "string" || !typecheck.includes("tsc -p tests")) {
    return;
  }

  const profileRel = NODE_TOOLING_PROFILE;
  const profile = path.join(root, profileRel);
  if (existsSync(profile)) {
    const json = readJsonc(profile, root);
    if (
      typeof json.extends !== "string" ||
      !json.extends.includes("tsconfig.base.json")
    ) {
      failures.push(`${profileRel}: must extend a shared tsconfig base`);
    }
    reportRemovedModuleResolution(
      failures,
      profileRel,
      isRecord(json.compilerOptions) ? json.compilerOptions : {}
    );
  } else {
    failures.push(`${profileRel}: missing Node tooling compiler profile`);
  }

  for (const program of ROOT_TOOLING_PROGRAMS) {
    const file = path.join(root, program.rel);
    const requiredFile = program.requiredWhen
      ? path.join(root, program.requiredWhen)
      : null;
    const required =
      existsSync(file) || !requiredFile || existsSync(requiredFile);
    if (!required) continue;
    if (existsSync(file)) {
      const json = readJsonc(file, root);
      if (typeof json.extends !== "string" || json.extends.length === 0) {
        failures.push(`${program.rel}: must extend a shared tsconfig base`);
      } else if (
        program.extendsNeedle &&
        !json.extends.includes(program.extendsNeedle)
      ) {
        failures.push(`${program.rel}: must extend ${program.extendsNeedle}`);
      }
      reportRemovedModuleResolution(
        failures,
        program.rel,
        isRecord(json.compilerOptions) ? json.compilerOptions : {}
      );
    } else {
      failures.push(`${program.rel}: missing Node tooling program`);
    }
    for (const needle of program.typecheckNeedles) {
      if (!typecheckMentions(typecheck, needle)) {
        failures.push(`package.json: typecheck must target ${needle}`);
      }
      if (!typecheckMentions(affected, needle)) {
        failures.push(`package.json: typecheck:affected must target ${needle}`);
      }
    }
  }
}

function readJsonc(file: string, root: string = ROOT): Record<string, unknown> {
  const result = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (result.error) {
    const message = ts.flattenDiagnosticMessageText(
      result.error.messageText,
      "\n"
    );
    throw new Error(`${path.relative(root, file)}: ${message}`);
  }
  return isRecord(result.config) ? result.config : {};
}

function workspaceDirs(root: string): string[] {
  return WORKSPACE_ROOTS.flatMap((workspaceRoot) => {
    const dir = path.join(root, workspaceRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  });
}

function tsconfigs(dir: string): string[] {
  return readdirSync(dir)
    .filter((name: string) => /^tsconfig(?:\.[\w-]+)?\.json$/u.test(name))
    .map((name: string) => path.join(dir, name));
}

function sourceTests(dir: string): string[] {
  const src = path.join(dir, "src");
  if (!existsSync(src)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
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

function parsedConfig(file: string, json: Record<string, unknown>) {
  return ts.parseJsonConfigFileContent(
    json,
    ts.sys,
    path.dirname(file),
    undefined,
    file
  );
}

function includesTests(parsed: ts.ParsedCommandLine, tests: string[]): boolean {
  const files = new Set(
    parsed.fileNames.map((file: string) => path.resolve(file))
  );
  return tests.every((file) => files.has(file));
}

/**
 * Check the tsconfig topology of every workspace under `root`. Pure over the
 * tree it is given (returns failures, never exits) — exported so the fail path
 * is testable.
 */
export function lintTsconfigs(root: string = ROOT): string[] {
  const failures: string[] = [];
  lintRootTooling(root, failures);
  for (const workspace of workspaceDirs(root)) {
    const rel = path.relative(root, workspace);
    const configs = tsconfigs(workspace);
    const byName = new Map(
      configs.map((file: string) => [path.basename(file), file])
    );

    for (const file of configs) {
      const json = readJsonc(file, root);
      const configRel = path.relative(root, file);
      const compilerOptions = isRecord(json.compilerOptions)
        ? json.compilerOptions
        : {};

      if (typeof json.extends !== "string" || json.extends.length === 0) {
        failures.push(`${configRel}: must extend a shared tsconfig base`);
      }
      if (compilerOptions.baseUrl !== undefined) {
        failures.push(`${configRel}: baseUrl is removed by TypeScript 7`);
      }
      reportRemovedModuleResolution(failures, configRel, compilerOptions);
    }

    const mainConfig = byName.get("tsconfig.json");
    if (!mainConfig) continue;
    const mainJson = readJsonc(mainConfig, root);
    const mainParsed = parsedConfig(mainConfig, mainJson);
    const tests = sourceTests(workspace);
    const testConfig = byName.get("tsconfig.test.json");
    const packageJson = path.join(workspace, "package.json");
    const typecheck = existsSync(packageJson)
      ? (() => {
          const scriptsValue = readJsonc(packageJson, root).scripts;
          const scripts = isRecord(scriptsValue) ? scriptsValue : {};
          return typeof scripts.typecheck === "string" ? scripts.typecheck : "";
        })()
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
