/*
 * Resolve an ACP adapter's executable from the installed npm package.
 *
 * Some coding CLIs don't speak ACP natively (Claude Code, Codex). For those
 * we spawn a first-party *adapter* — a small Node program that speaks ACP on
 * stdio and drives the real CLI underneath. The adapters are pinned
 * dependencies of this package (`@agentclientprotocol/claude-agent-acp`,
 * `@agentclientprotocol/codex-acp`), never fetched at run time: an
 * `npx -y <pkg>` would put a network round-trip (and an unpinned version) in
 * the middle of every turn and every test.
 *
 * We resolve the package's own `package.json` — both adapters expose it, and
 * `require.resolve` walks the same node_modules chain the runtime already
 * uses — then join its `bin` entry. Resolving the bin rather than the `main`
 * export matters: `main` is a library entry (`dist/lib.js` for the claude
 * adapter) that does NOT start the stdio server.
 *
 * The adapters are ESM Node programs, so they are launched as
 * `process.execPath <entry>` rather than executed directly. That also avoids
 * depending on a `node_modules/.bin` shim, which `spawn-env.ts` deliberately
 * strips off `PATH`.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/** Resolved entry points, memoized per package (the answer can't change at run time). */
const cache = new Map<string, string>();

/**
 * Absolute path to `packageName`'s ACP-server entry point.
 *
 * Throws when the adapter isn't installed — a packaging bug, not a user
 * misconfiguration, so it surfaces as a turn error rather than being
 * swallowed.
 */
export function resolveAdapterEntry(packageName: string): string {
  const hit = cache.get(packageName);
  if (hit) return hit;

  let manifestPath: string;
  try {
    manifestPath = require_.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `ACP adapter "${packageName}" is not installed — reinstall @centraid/agent-runtime's dependencies.`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel =
    typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  if (!rel) {
    throw new Error(`ACP adapter "${packageName}" declares no bin entry.`);
  }

  const entry = path.join(path.dirname(manifestPath), rel);
  cache.set(packageName, entry);
  return entry;
}
