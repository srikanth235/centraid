import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  WebControlSessionStore,
  hashControlToken,
  CONTROL_IDLE_TTL_MS,
} from "./web-session-store.js";

let dir: string;
let file: string;

describe("web-session-store", () => {
  beforeEach(async () => {
    dir = await tempDir(`web-session-store-${crypto.randomUUID()}-`);
    file = path.join(dir, "web-sessions.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function rows(): Array<Record<string, unknown>> {
    const db = new DatabaseSync(path.join(dir, "gateway.db"), {
      readOnly: true,
    });
    const result = db
      .prepare(
        `SELECT token_hash AS tokenHash, expires_at AS expiresAt
         FROM web_sessions ORDER BY created_at`
      )
      .all() as Array<Record<string, unknown>>;
    db.close();
    return result;
  }

  test("a persisted control session is found by a fresh store on the same file (restart)", () => {
    const hash = hashControlToken("cookie-token");
    const first = WebControlSessionStore.open(file);
    first.establish({
      tokenHash: hash,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });

    // Only the SHA-256 hash lands in gateway.db, never the raw token.
    expect(rows()[0]?.tokenHash).toBe(hash);
    expect(JSON.stringify(rows())).not.toContain("cookie-token");

    const reopened = WebControlSessionStore.open(file);
    const found = reopened.find(hash);
    expect(found?.vaultId).toBe("v1");
    expect(found?.shellOrigin).toBe("http://shell");
  });

  test("an expired-on-disk row does not authorize and is swept on open", () => {
    let now = 1_000_000;
    const clock = (): number => now;
    const hash = hashControlToken("t");
    const store = WebControlSessionStore.open(file, clock);
    store.establish({
      tokenHash: hash,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });

    // Jump past the sliding idle wall.
    now += CONTROL_IDLE_TTL_MS + 1;
    expect(store.find(hash)).toBeUndefined();

    // A fresh open at the same time drops the dead row from disk.
    const reopened = WebControlSessionStore.open(file, clock);
    expect(reopened.list()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  test("touch slides the idle window but throttles disk writes to ~hourly", () => {
    let now = 5_000_000;
    const clock = (): number => now;
    const hash = hashControlToken("t");
    const store = WebControlSessionStore.open(file, clock);
    store.establish({
      tokenHash: hash,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });
    const firstExpiry = rows()[0]?.expiresAt as number;

    // A use 30 minutes later is under the hourly throttle → no disk rewrite.
    now += 30 * 60 * 1000;
    store.touch(hash);
    expect(rows()[0]?.expiresAt).toBe(firstExpiry);

    // A use past the hour extends the persisted window.
    now += 40 * 60 * 1000; // 70 min since establish
    store.touch(hash);
    expect(rows()[0]?.expiresAt).toBe(now + CONTROL_IDLE_TTL_MS);
    expect(rows()[0]?.expiresAt as number).toBeGreaterThan(firstExpiry);
  });

  test("establish replaces only the same cookie hash; other sessions survive", () => {
    const store = WebControlSessionStore.open(file);
    const a = hashControlToken("a");
    const b = hashControlToken("b");
    store.establish({
      tokenHash: a,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });
    store.establish({
      tokenHash: b,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });
    expect(store.list()).toHaveLength(2);

    // Re-establishing `a` (a re-pair from the same browser) does not evict `b`.
    store.establish({
      tokenHash: a,
      vaultId: "v1",
      shellOrigin: "http://shell2",
    });
    expect(store.list()).toHaveLength(2);
    expect(store.find(b)).toBeDefined();
    expect(store.find(a)?.shellOrigin).toBe("http://shell2");
  });

  test("remove deletes one session (logout / revocation) and persists", () => {
    const store = WebControlSessionStore.open(file);
    const hash = hashControlToken("t");
    store.establish({
      tokenHash: hash,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });
    expect(store.remove(hash)).toBe(true);
    expect(store.find(hash)).toBeUndefined();
    expect(rows()).toHaveLength(0);
    // Idempotent — a second remove is a no-op.
    expect(store.remove(hash)).toBe(false);
  });

  test("in-memory mode (no file) keeps sessions without touching disk", () => {
    const store = WebControlSessionStore.open();
    const hash = hashControlToken("t");
    store.establish({
      tokenHash: hash,
      vaultId: "v1",
      shellOrigin: "http://shell",
    });
    expect(store.find(hash)?.vaultId).toBe("v1");
    // Nothing was written under the temp dir.
    expect(store.list()).toHaveLength(1);
  });
});
