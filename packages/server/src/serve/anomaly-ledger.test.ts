import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  ANOMALY_KINDS,
  AnomalyLedger,
  fingerprintStack,
  readAnomalyLedger,
} from "./anomaly-ledger.js";

/** Injected clock — the ledger never reads the wall clock itself. */
function fixedClock(startMs = Date.parse("2026-08-21T00:00:00.000Z")) {
  let tick = 0;
  return (): number => {
    tick += 1;
    return startMs + tick * 1000;
  };
}

describe("fingerprintStack", () => {
  test("keeps function and basename, drops the directory that names the owner", () => {
    const stack = [
      "Error: mount failed",
      "    at VaultRegistry.mount (/Users/priya/Library/Application Support/Centraid/dist/serve/vault-registry.js:710:14)",
      "    at async /Users/priya/Library/Application Support/Centraid/dist/serve/build-gateway.js:88:3",
    ].join("\n");
    const frames = fingerprintStack(stack);
    expect(frames).toStrictEqual([
      "VaultRegistry.mount@vault-registry.js:710",
      "build-gateway.js:88",
    ]);
    expect(frames.join(" ")).not.toContain("priya");
    expect(frames.join(" ")).not.toContain("/");
  });

  test("drops frames it cannot parse rather than passing them through", () => {
    expect(fingerprintStack("Error: x\n    at <weird /Users/priya frame>")).toStrictEqual(
      []
    );
    expect(fingerprintStack(undefined)).toStrictEqual([]);
  });
});

describe("AnomalyLedger", () => {
  test("records structured facts and never the message plaintext", () => {
    const ledger = new AnomalyLedger({ now: fixedClock() });
    const entry = ledger.record({
      kind: "vault-mount-failure",
      severity: "error",
      code: "vault.mount.schema-mismatch",
      component: "serve.vault-registry",
      message: 'could not mount "Priya\'s private vault" at /Users/priya/v',
      facts: { attempt: 2, recovered: false },
    });
    expect(entry.seq).toBe(1);
    expect(entry.at).toBe("2026-08-21T00:00:01.000Z");
    expect(entry.messageDigest).toHaveLength(12);
    expect(entry.facts).toStrictEqual({ attempt: 2, recovered: false });
    expect(JSON.stringify(entry)).not.toContain("Priya");
    expect(JSON.stringify(entry)).not.toContain("/Users");
  });

  test("refuses non-token codes and string-valued facts", () => {
    const ledger = new AnomalyLedger({ now: fixedClock() });
    const entry = ledger.record({
      kind: "automation-fault",
      severity: "warn",
      code: 'failed for "Priya\'s note"',
      component: "Photos Import (Priya)",
      facts: {
        // A string fact is the channel this ledger deliberately does not have.
        detail: "hunter2" as unknown as number,
        accessToken: 3,
        retries: 4,
      },
    });
    expect(entry.code).toBe("unknown");
    expect(entry.component).toBe("unknown");
    expect(entry.facts).toStrictEqual({ retries: 4 });
  });

  test("derives digest and stack from a thrown Error", () => {
    const ledger = new AnomalyLedger({ now: fixedClock() });
    const entry = ledger.record({
      kind: "uncaught-exception",
      severity: "fatal",
      code: "engine.turn.crash",
      component: "engine.turn",
      error: new Error("boom"),
    });
    expect(entry.stack.length).toBeGreaterThan(0);
    expect(entry.stack.every((frame) => !frame.includes("/"))).toBe(true);
  });

  test("is a bounded ring and reports a histogram by code", () => {
    const ledger = new AnomalyLedger({ now: fixedClock(), capacity: 3 });
    for (let index = 0; index < 5; index += 1)
      ledger.record({
        kind: "disk-full",
        severity: "error",
        code: index % 2 === 0 ? "disk.full.append" : "disk.full.checkpoint",
        component: "serve.log-store",
      });
    const snapshot = ledger.snapshot();
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map((entry) => entry.seq)).toStrictEqual([3, 4, 5]);
    expect(ledger.histogram()).toStrictEqual({
      "disk.full.append": 2,
      "disk.full.checkpoint": 1,
    });
  });

  test("mirrors to disk and reads back across a restart", () => {
    const dir = tempDirSync("anomaly-ledger-");
    const ledger = new AnomalyLedger({ dir, now: fixedClock() });
    ledger.record({
      kind: "migration-failure",
      severity: "fatal",
      code: "vault.migrate.epoch",
      component: "vault.migrate",
    });
    fs.appendFileSync(path.join(dir, "anomalies.jsonl"), "{torn line\n");
    const restored = readAnomalyLedger(dir);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.code).toBe("vault.migrate.epoch");
  });

  test("a write failure is counted, never thrown — the observer cannot crash the observed", () => {
    // A regular file where a directory has to be: `mkdirSync` fails ENOTDIR.
    const blocked = tempDirSync("anomaly-blocked-");
    fs.writeFileSync(path.join(blocked, "wall"), "x");
    const ledger = new AnomalyLedger({
      dir: path.join(blocked, "wall", "nested"),
      now: fixedClock(),
    });
    expect(() =>
      ledger.record({
        kind: "disk-full",
        severity: "error",
        code: "disk.full.append",
        component: "serve.log-store",
      })
    ).not.toThrow();
    expect(ledger.dropped).toBe(1);
    // The in-memory ring keeps working when persistence does not.
    expect(ledger.snapshot()).toHaveLength(1);
  });

  test("every declared kind is recordable", () => {
    const ledger = new AnomalyLedger({ now: fixedClock() });
    for (const kind of ANOMALY_KINDS)
      expect(
        ledger.record({
          kind,
          severity: "warn",
          code: "probe.kind.check",
          component: "test",
        }).kind
      ).toBe(kind);
  });
});
