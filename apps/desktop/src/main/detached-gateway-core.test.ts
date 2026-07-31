import { describe, expect, it } from "vitest";

import {
  buildDetachedSpawnOptions,
  classifyLockStatus,
  decideControl,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_OFFER_GATEWAY_SERVICE,
  describeDeviceCustodyGap,
  describeLockRefusal,
  describePortConflict,
  deviceCustodyGap,
  lockViewFor,
  resolveListenPort,
  shouldOfferServiceInstall,
} from "./detached-gateway-core.js";
import type { LockStatusRun } from "./detached-gateway-core.js";

describe("decideControl (gateway.db lock-informed adopt-don't-kill)", () => {
  it("owns a held lock only when the device credential reaches the daemon", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: true,
        publicProbeOk: true,
      })
    ).toBe("own");
  });

  it("treats an answering daemon without our credential as foreign", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: false,
        publicProbeOk: true,
      })
    ).toBe("foreign");
  });

  it("refuses a lock holder that is not answering", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: false,
        publicProbeOk: false,
      })
    ).toBe("probe-failed-refuse");
  });

  it("starts when the kernel lock is free regardless of stale probe state", () => {
    expect(
      decideControl({
        lockHeld: false,
        credentialedProbeOk: false,
        publicProbeOk: false,
      })
    ).toBe("stale-reclaim");
  });
});

/** A `lock-status` run with nothing interesting in it; override per case. */
function run(patch: Partial<LockStatusRun> = {}): LockStatusRun {
  return { stdout: "", stderr: "", status: 1, timedOut: false, ...patch };
}

describe(classifyLockStatus, () => {
  it("reads the CLI's JSON answer, holder pid included", () => {
    expect(
      classifyLockStatus(
        run({
          stdout: `${JSON.stringify({ ok: true, held: true, answering: true, holderPid: 4242 })}\n`,
          status: 0,
        })
      )
    ).toStrictEqual({
      kind: "reported",
      held: true,
      answering: true,
      holderPid: 4242,
    });
  });

  it("ignores banner noise before the JSON line", () => {
    expect(
      classifyLockStatus(
        run({
          stdout: `warming up\n${JSON.stringify({ ok: true, held: false, answering: false })}\n`,
          status: 0,
        })
      )
    ).toStrictEqual({ kind: "reported", held: false, answering: false });
  });

  // D5: wrong/absent wrapping key. The CLI cannot open the key store, so it
  // never reaches the lock at all — treating this as "locked" was the bug.
  it("names a key-store failure as a custody mismatch, not a lock", () => {
    const probe = classifyLockStatus(
      run({
        stderr:
          "centraid-gateway: KeyStoreError: endpoint-key.bin will not unwrap under the supplied master key\n    at KeyStore.load\n",
      })
    );
    expect(probe).toStrictEqual({
      kind: "custody-mismatch",
      detail:
        "centraid-gateway: KeyStoreError: endpoint-key.bin will not unwrap under the supplied master key",
    });
  });

  // D4: the CLI blocks on the stopped holder's SQLite lock and we kill it at
  // the spawn timeout — genuinely held, but by something not answering at all.
  it("distinguishes a spawn timeout from a fast CLI failure", () => {
    expect(
      classifyLockStatus(run({ timedOut: true, status: null }))
    ).toStrictEqual({ kind: "holder-unresponsive" });
    expect(
      classifyLockStatus(run({ stderr: "cannot find module\n", status: 2 }))
    ).toStrictEqual({ kind: "cli-failed", detail: "cannot find module" });
  });

  // The gateway CLI always emits `(node:N) ExperimentalWarning: SQLite …`, so
  // the FIRST stderr line is routinely not the failure.
  it("skips Node's own diagnostics when quoting the failure", () => {
    expect(
      classifyLockStatus(
        run({
          stderr:
            "(node:400) ExperimentalWarning: SQLite is an experimental feature\n" +
            "centraid-gateway: KeyStoreError: will not unwrap\n",
        })
      )
    ).toStrictEqual({
      kind: "custody-mismatch",
      detail: "centraid-gateway: KeyStoreError: will not unwrap",
    });
    expect(
      classifyLockStatus(
        run({
          stderr:
            "(node:400) ExperimentalWarning: SQLite is an experimental feature\n" +
            "centraid-gateway: ENOENT no such file\n",
          status: 1,
        })
      )
    ).toStrictEqual({
      kind: "cli-failed",
      detail: "centraid-gateway: ENOENT no such file",
    });
  });

  it("falls back to the exit code when the CLI said nothing at all", () => {
    expect(classifyLockStatus(run({ status: 7 }))).toStrictEqual({
      kind: "cli-failed",
      detail: "exit 7",
    });
  });

  it("treats a truncated or non-status JSON line as no answer", () => {
    expect(classifyLockStatus(run({ stdout: '{"ok":true,"he' })).kind).toBe(
      "cli-failed"
    );
    expect(
      classifyLockStatus(run({ stdout: '{"ok":false,"error":"nope"}' })).kind
    ).toBe("cli-failed");
  });
});

describe(lockViewFor, () => {
  it("stays fail-closed for every probe it could not read", () => {
    for (const probe of [
      { kind: "custody-mismatch", detail: "x" },
      { kind: "holder-unresponsive" },
      { kind: "cli-failed", detail: "x" },
    ] as const) {
      expect(lockViewFor(probe)).toStrictEqual({
        held: true,
        answering: false,
      });
      // …and fail-closed must still mean "refuse", not "spawn".
      expect(
        decideControl({
          lockHeld: lockViewFor(probe).held,
          credentialedProbeOk: false,
          publicProbeOk: false,
        })
      ).toBe("probe-failed-refuse");
    }
  });

  it("passes a reported lock through untouched", () => {
    expect(
      lockViewFor({
        kind: "reported",
        held: true,
        answering: false,
        holderPid: 91,
      })
    ).toStrictEqual({ held: true, answering: false, holderPid: 91 });
  });
});

describe(describeLockRefusal, () => {
  const dataDir = "/tmp/centraid-gw";

  it("says credentials — not locks — when the key store would not open", () => {
    const message = describeLockRefusal({
      probe: { kind: "custody-mismatch", detail: "KeyStoreError: nope" },
      dataDir,
    });
    expect(message).toContain("device credentials");
    expect(message).toContain("gateway.db itself is not locked");
    expect(message).toContain("KeyStoreError: nope");
    expect(message).not.toContain("second writer");
  });

  it("carries the OS holder pid when the CLI could not name it", () => {
    const message = describeLockRefusal({
      probe: { kind: "holder-unresponsive" },
      dataDir,
      holderPid: 3131,
    });
    expect(message).toContain("OS holder pid 3131");
    expect(message).toContain("not responding");
    expect(message).toContain("second writer");
  });

  it("keeps the genuine held-lock refusal, with the pid", () => {
    expect(
      describeLockRefusal({
        probe: { kind: "reported", held: true, answering: false },
        dataDir,
        holderPid: 12,
      })
    ).toBe(
      "gateway.db is locked but the daemon is not answering — refusing to start " +
        "a second writer (OS holder pid 12)"
    );
  });

  it("admits when the lock state is simply unknown", () => {
    const message = describeLockRefusal({
      probe: { kind: "cli-failed", detail: "exit 2" },
      dataDir,
    });
    expect(message).toContain("could not read the gateway.db lock state");
    expect(message).toContain("exit 2");
  });

  it("gives the four outcomes four different messages", () => {
    const messages = new Set(
      (
        [
          { kind: "reported", held: true, answering: false },
          { kind: "custody-mismatch", detail: "d" },
          { kind: "holder-unresponsive" },
          { kind: "cli-failed", detail: "d" },
        ] as const
      ).map((probe) => describeLockRefusal({ probe, dataDir }))
    );
    expect(messages.size).toBe(4);
  });
});

describe(deviceCustodyGap, () => {
  // E2: connection-secrets.bin removed while the data dir stayed. Minting a
  // fresh wrapping key here orphans the envelopes already in keys/.
  it("fires only for an existing gateway this device has no key for", () => {
    expect(
      deviceCustodyGap({
        hasStoredWrappingKey: false,
        gatewayKeysPresent: true,
      })
    ).toBe(true);
    // A brand-new data dir: minting is exactly right.
    expect(
      deviceCustodyGap({
        hasStoredWrappingKey: false,
        gatewayKeysPresent: false,
      })
    ).toBe(false);
    // We hold the key — whatever else is wrong, it isn't custody.
    expect(
      deviceCustodyGap({ hasStoredWrappingKey: true, gatewayKeysPresent: true })
    ).toBe(false);
  });

  it("explains the gap in terms of the credential, not the lock", () => {
    const message = describeDeviceCustodyGap("/tmp/centraid-gw");
    expect(message).toContain("/tmp/centraid-gw");
    expect(message).toContain("device credential");
    expect(message).not.toMatch(/lock/iu);
  });
});

describe(describePortConflict, () => {
  it("names the port, the squatter's pid, and our data dir", () => {
    const message = describePortConflict({
      host: "127.0.0.1",
      port: DEFAULT_GATEWAY_PORT,
      dataDir: "/tmp/fresh",
      pid: 808,
    });
    expect(message).toContain("pid 808");
    expect(message).toContain(`127.0.0.1:${DEFAULT_GATEWAY_PORT}`);
    expect(message).toContain("/tmp/fresh");
  });

  it("stays legible when lsof could not name the holder", () => {
    expect(
      describePortConflict({
        host: "127.0.0.1",
        port: 17832,
        dataDir: "/tmp/fresh",
      })
    ).not.toContain("pid");
  });
});

describe(resolveListenPort, () => {
  it("returns the stable default when unconfigured", () => {
    expect(resolveListenPort()).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(undefined)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("rejects zero / negative / out-of-range and falls back to default", () => {
    expect(resolveListenPort(0)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(-1)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(70000)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(1.5)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("accepts a positive configured port", () => {
    expect(resolveListenPort(8765)).toBe(8765);
  });
});

describe("buildDetachedSpawnOptions (H2)", () => {
  it("describes detached + ignored stdio + unref", () => {
    expect(buildDetachedSpawnOptions()).toStrictEqual({
      detached: true,
      stdio: "ignore",
      unref: true,
    });
  });
});

describe("shouldOfferServiceInstall (H5)", () => {
  it("defaults install off but offers the step during first-run onboarding", () => {
    expect(DEFAULT_OFFER_GATEWAY_SERVICE).toBe(false);
    // No decision + no onboarding stamp → show the opt-in step.
    expect(shouldOfferServiceInstall({})).toBe(true);
  });

  it("does not re-offer after the user decides or finishes onboarding", () => {
    expect(shouldOfferServiceInstall({ offerGatewayService: false })).toBe(
      false
    );
    expect(shouldOfferServiceInstall({ offerGatewayService: true })).toBe(
      false
    );
    expect(
      shouldOfferServiceInstall({
        onboardingCompletedAt: "2026-07-20T00:00:00.000Z",
      })
    ).toBe(false);
  });
});
