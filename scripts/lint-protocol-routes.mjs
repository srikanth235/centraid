#!/usr/bin/env node
/**
 * Route-literal drift check (issue #504 batch 2).
 *
 * Fails when apps/extension (or packages/cli) hard-codes a path that is
 * already defined in @centraid/protocol ROUTES, instead of importing it.
 * Gateway/app-engine still contain many historical literals — those migrate
 * gradually; the extension + product CLI are the drift-prone consumers.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keep in sync with packages/protocol/src/routes.ts ROUTES values.
const ROUTE_PATHS = [
  '/centraid/_gateway/info',
  '/centraid/_gateway/health',
  '/centraid/_gateway/devices',
  '/centraid/_gateway/pair',
  '/centraid/_vault/status',
  '/centraid/_vault/blocking',
  '/centraid/_vault/blobs',
  '/centraid/_vault/apps',
  '/centraid/_apps',
  '/centraid/_web/session',
  '/centraid/_web/control',
];

const SCOPES = ['apps/extension/src', 'packages/cli/src'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx|js|mjs)$/.test(name) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const scope of SCOPES) {
  const dir = path.join(root, scope);
  let files;
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // Files that import ROUTES from protocol are allowed to only use ROUTES.*
    // — any remaining string literal matching a known path is a violation.
    for (const route of ROUTE_PATHS) {
      // Match quoted string literals exactly equal to the route (or route + query).
      const re = new RegExp(
        `['"\`]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?[^'"\`]*)?['"\`]`,
      );
      if (re.test(text)) {
        violations.push(
          `${path.relative(root, file)}: hard-coded ${route} (import ROUTES from @centraid/protocol)`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`protocol route-literal drift (#504):\n${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(
  `protocol routes: ok (${ROUTE_PATHS.length} paths, scopes ${SCOPES.join(', ')})\n`,
);
