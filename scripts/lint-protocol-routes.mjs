#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const ROUTE_PATHS = [
  "/centraid/_gateway/info",
  "/centraid/_gateway/health",
  "/centraid/_gateway/devices",
  "/centraid/_gateway/pair",
  "/centraid/_vault/status",
  "/centraid/_vault/blocking",
  "/centraid/_vault/blobs",
  "/centraid/_vault/apps",
  "/centraid/_vault/connections",
  "/centraid/_vault/connections/providers",
  "/centraid/_vault/connections/assist",
  "/centraid/_vault/connections/assist/complete",
  "/centraid/_vault/oauth/callback",
  "/centraid/_apps",
  "/centraid/_web/session",
  "/centraid/_web/control",
];

const SCOPES = ["apps/extension/src", "packages/cli/src"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (
      /\.(?:ts|tsx|js|mjs)$/u.test(name) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

export function findRouteLiterals(scanRoot = root, scopes = SCOPES) {
  const violations = [];
  for (const scope of scopes) {
    const dir = path.join(scanRoot, scope);
    let files;
    try {
      files = walk(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const route of ROUTE_PATHS) {
        const re = new RegExp(
          `['"\`]${route.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\?[^'"\`]*)?['"\`]`,
          "u"
        );
        if (re.test(text)) {
          violations.push(
            `${path.relative(scanRoot, file)}: hard-coded ${route} (import ROUTES from @centraid/core/protocol)`
          );
        }
      }
    }
  }
  return violations;
}

function main() {
  const violations = findRouteLiterals();
  if (violations.length > 0) {
    process.stderr.write(
      `protocol route-literal drift (#504):\n${violations.join("\n")}\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `protocol routes: ok (${ROUTE_PATHS.length} paths, scopes ${SCOPES.join(", ")})\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
