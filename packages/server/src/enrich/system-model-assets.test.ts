import { describe, expect, test } from "vitest";

import type {
  EnsureModelAssetsOptions,
  EnsureModelAssetsResult,
  ModelLock,
} from "@centraid/model-runtime";

import {
  NOT_PROVISIONED_DETAIL,
  RETRY_BASE_MS,
  SystemModelAssets,
  systemAutomationCapabilities,
} from "./system-model-assets.js";
import type { SystemModelAssetsOptions } from "./system-model-assets.js";
import { SYSTEM_AUTOMATION_IDS } from "./system-recognition.js";

// A synthetic manifest in the real shape: the mapping under test is
// automation id → its handler's model id → that model's pinned capabilities.
const LOCK: ModelLock = {
  schemaVersion: 1,
  files: [
    {
      model: "yunet-arcface@1",
      path: "faces/yunet.onnx",
      capabilities: ["faces"],
      bytes: 1,
      sha256: "a",
      license: "MIT",
      url: "https://example.invalid/yunet",
    },
    {
      model: "yunet-arcface@1",
      path: "faces/arcface.onnx",
      capabilities: ["faces"],
      bytes: 2,
      sha256: "b",
      license: "Apache-2.0",
      url: "https://example.invalid/arcface",
    },
    {
      model: "pp-ocrv5@1",
      path: "ocr/det.onnx",
      capabilities: ["ocr"],
      bytes: 3,
      sha256: "c",
      license: "Apache-2.0",
      url: "https://example.invalid/det",
    },
    {
      model: "clip-vit-b-32@1",
      path: "clip/visual.onnx",
      capabilities: ["embed-image", "embed-text"],
      bytes: 4,
      sha256: "d",
      license: "MIT",
      url: "https://example.invalid/clip",
    },
  ],
};

interface Harness {
  assets: SystemModelAssets;
  calls: EnsureModelAssetsOptions[];
  reports: { status: "ok" | "degraded"; detail: string }[];
  logs: string[];
  /** Pending retry timers, newest last, with the delay each was armed for. */
  timers: { delayMs: number; fire: () => void }[];
}

function harness(
  ensure: (
    options: EnsureModelAssetsOptions
  ) => Promise<EnsureModelAssetsResult>,
  overrides: Partial<SystemModelAssetsOptions> = {}
): Harness {
  const calls: EnsureModelAssetsOptions[] = [];
  const reports: { status: "ok" | "degraded"; detail: string }[] = [];
  const logs: string[] = [];
  const timers: { delayMs: number; fire: () => void }[] = [];
  const assets = new SystemModelAssets({
    provision: "fetch",
    runtimeDirFor: (automationId) => `/runtime/${automationId}`,
    report: (status, detail) => reports.push({ status, detail }),
    log: (_level, message) => logs.push(message),
    readLock: () => Promise.resolve(LOCK),
    ensure: (options) => {
      calls.push(options);
      return ensure(options);
    },
    schedule: (fn, delayMs) => {
      const entry = { delayMs, fire: fn };
      timers.push(entry);
      return () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    ...overrides,
  });
  return { assets, calls, reports, logs, timers };
}

const ok = (capabilities: readonly string[]): EnsureModelAssetsResult => ({
  ready: [...capabilities],
  fetched: [],
  failed: [],
});

describe("system model assets (#1011)", () => {
  test("capabilities come from the lock, keyed by the handler's own model id", () => {
    expect(systemAutomationCapabilities(LOCK, "faces")).toStrictEqual([
      "faces",
    ]);
    expect(systemAutomationCapabilities(LOCK, "photo-ocr")).toStrictEqual([
      "ocr",
    ]);
    // No bundled deterministic engine, so nothing to provision — and never
    // `preparing` for want of weights it does not have.
    expect(
      systemAutomationCapabilities(LOCK, "doc-text-extractor")
    ).toStrictEqual([]);
  });

  test("every system automation has a state before anything is fetched", () => {
    const { assets } = harness(() => Promise.resolve(ok([])));
    for (const id of SYSTEM_AUTOMATION_IDS) {
      expect(assets.readiness(id)).toBeDefined();
    }
    // A weightless system automation is READY from the start: it is on, and
    // there is nothing for it to wait for.
    expect(assets.readiness("doc-text-extractor")?.state).toBe("ready");
    expect(assets.readiness("faces")?.state).toBe("preparing");
    expect(assets.readiness("not-a-system-automation")).toBeUndefined();
  });

  test("missing → preparing → ready, and the fire skip lifts with it", async () => {
    let present = false;
    const { assets, calls, reports, timers } = harness((options) =>
      Promise.resolve(
        present
          ? ok(options.capabilities)
          : {
              ready: [],
              fetched: [],
              failed: options.capabilities.map((capability) => ({
                capability,
                error: "weights are not on disk",
              })),
            }
      )
    );

    await assets.runOnce();
    expect(assets.readiness("faces")?.state).toBe("preparing");
    expect(assets.skipReason("faces")).toContain("preparing");
    expect(assets.skipReason("faces")).toContain("weights are not on disk");
    // Never a reason to skip a recipe that carries no weights.
    expect(assets.skipReason("doc-text-extractor")).toBeUndefined();
    expect(reports.at(-1)?.status).toBe("degraded");
    // Each automation is provisioned into the directory ITS handler reads.
    expect(calls.map((call) => call.runtimeDir)).toStrictEqual([
      "/runtime/faces",
      "/runtime/photo-ocr",
    ]);

    present = true;
    await assets.runOnce();
    expect(assets.readiness("faces")?.state).toBe("ready");
    expect(assets.readiness("photo-ocr")?.state).toBe("ready");
    // Ready means nothing is skipped and nothing is scheduled to retry.
    expect(assets.skipReason("faces")).toBeUndefined();
    expect(assets.skipReason("photo-ocr")).toBeUndefined();
    expect(reports.at(-1)?.status).toBe("ok");
    expect(timers).toHaveLength(0);
  });

  test("a failure retries on a backoff, never a tight loop", async () => {
    let attempts = 0;
    const { assets, timers, reports } = harness((options) => {
      attempts += 1;
      // Succeed on the third pass so the backoff's growth is observable.
      return Promise.resolve(
        attempts > 4
          ? ok(options.capabilities)
          : {
              ready: [],
              fetched: [],
              failed: [{ capability: "faces", error: "network unreachable" }],
            }
      );
    });

    await assets.runOnce();
    expect(assets.readiness("faces")?.state).toBe("preparing");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(RETRY_BASE_MS);
    expect(reports.at(-1)?.detail).toContain("network unreachable");
    expect(reports.at(-1)?.detail).toContain("retrying in");

    // Second pass still fails: the delay DOUBLES rather than re-firing at once.
    const first = timers.shift();
    first?.fire();
    await assets.runOnce();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(RETRY_BASE_MS * 2);

    const second = timers.shift();
    second?.fire();
    await assets.runOnce();
    expect(assets.readiness("faces")?.state).toBe("ready");
    expect(timers).toHaveLength(0);
    expect(reports.at(-1)?.status).toBe("ok");
  });

  test("a thrown fetch is caught, reported and retried — boot never sees it", async () => {
    const { assets, timers, reports } = harness(() =>
      Promise.reject(new Error("EACCES /runtime"))
    );
    await expect(assets.runOnce()).resolves.toBeUndefined();
    expect(assets.readiness("faces")?.detail).toContain("EACCES /runtime");
    expect(reports.at(-1)?.status).toBe("degraded");
    expect(timers).toHaveLength(1);
  });

  test("an unreadable manifest leaves every weighted automation preparing", async () => {
    const { assets, calls } = harness(() => Promise.resolve(ok([])), {
      readLock: () => Promise.reject(new Error("models.lock.json is missing")),
    });
    await assets.runOnce();
    expect(calls).toHaveLength(0);
    expect(assets.readiness("faces")?.detail).toContain(
      "models.lock.json is missing"
    );
    expect(assets.readiness("photo-ocr")?.state).toBe("preparing");
    // Still not a reason to hold back the automation that needs no weights.
    expect(assets.readiness("doc-text-extractor")?.state).toBe("ready");
  });

  test("verify-only never fetches, never retries, and says so", async () => {
    // The DEFAULT posture (#1011): a host that has not been configured to
    // provision weights reports what is on disk and stops. `ensure` here
    // stands for the verify path the mode selects; the mode's own contract
    // is that nothing is scheduled and the owner is told why.
    const { assets, calls, reports, timers } = harness(
      (options) =>
        Promise.resolve({
          ready: [],
          fetched: [],
          failed: options.capabilities.map((capability) => ({
            capability,
            error: "missing or unverified: faces/yunet.onnx",
          })),
        }),
      { provision: "verify-only" }
    );

    await assets.runOnce();
    expect(calls).toHaveLength(2);
    expect(assets.readiness("faces")?.state).toBe("preparing");
    expect(assets.readiness("faces")?.detail).toContain(NOT_PROVISIONED_DETAIL);
    expect(assets.skipReason("faces")).toContain(NOT_PROVISIONED_DETAIL);
    expect(reports.at(-1)?.status).toBe("degraded");
    // Nothing on this host is going to make the weights appear, so no timer
    // is armed and the owner is not told to expect one.
    expect(timers).toHaveLength(0);
    expect(reports.at(-1)?.detail).not.toContain("retrying in");
  });

  test("verify-only goes ready when the weights are already on disk", async () => {
    const { assets, reports, timers } = harness(
      (options) => Promise.resolve(ok(options.capabilities)),
      { provision: "verify-only" }
    );
    await assets.runOnce();
    expect(assets.readiness("faces")?.state).toBe("ready");
    expect(assets.readiness("photo-ocr")?.state).toBe("ready");
    expect(reports.at(-1)?.status).toBe("ok");
    expect(timers).toHaveLength(0);
  });

  test("start() is fire-and-forget and runs at most once", async () => {
    const { assets, calls } = harness((options) =>
      Promise.resolve(ok(options.capabilities))
    );
    assets.start();
    assets.start();
    await assets.runOnce();
    expect(calls).toHaveLength(2); // faces + photo-ocr, one pass
  });
});
