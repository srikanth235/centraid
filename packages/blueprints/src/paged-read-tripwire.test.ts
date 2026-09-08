/*
 * THE TRUNCATION FLAG IS GONE, AND THIS IS WHAT KEEPS IT GONE (#996 wave 4, R8).
 *
 * Roughly two hundred reads across the eight apps declared
 * `acceptTruncation: true`: "give me the default window and tell me when it
 * fills". Each was rewritten as a paged handler, never converted flag by flag,
 * because the flag's problem was not its value — it was that the window was
 * invisible at the call site and "there is more" was a dead end rather than a
 * continuation.
 *
 * A per-call-site rule cannot hold that: a rule is satisfiable by a new call
 * site. A grep is not. So this is a grep, over the two trees an app's reads
 * live in — `packages/blueprints/apps` here and `apps/mobile/src` in the
 * phone's own census (`replica-read-windows.test.ts`) — and it fails on any
 * hit, including in a comment, because a word that is allowed in a comment is a
 * word somebody will paste back into a request.
 *
 * `ctx.vault.read` goes the same way and for the same reason: it is the request
 * the flag belonged to, and no app may call it after this wave. The generic
 * read itself survives on the gateway for automations and the server's own
 * callers (F2), where "truncation is never silent" is a property R17 needs —
 * that is a different door with a different caller, and this grep is scoped to
 * the apps.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const APPS = path.join(import.meta.dirname, "..", "apps");

/** This file names the words in order to forbid them. */
const SELF = "paged-read-tripwire.test.ts";

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, found);
      continue;
    }
    if (/\.tsx?$/u.test(entry)) found.push(full);
  }
  return found;
}

function hits(pattern: RegExp): string[] {
  return sources(APPS).flatMap((file) => {
    if (path.basename(file) === SELF) return [];
    return pattern.test(readFileSync(file, "utf8"))
      ? [path.relative(APPS, file)]
      : [];
  });
}

describe("every app read is a page", () => {
  test("no app declares the truncation flag", () => {
    expect(hits(/acceptTruncation|UNBOUNDED_READ/u)).toStrictEqual([]);
  });

  test("no app calls the generic declarative read", () => {
    expect(hits(/\bvault\s*\.\s*read\s*\(/u)).toStrictEqual([]);
  });
});
