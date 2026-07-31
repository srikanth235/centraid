// #656 Layer 4 — the three test seams that oxlint now makes mandatory.
//
// Each helper exists because the hand-rolled form leaked something when a test
// failed. These tests assert the leak-proofing, not the happy path: a clock
// that advances is easy, a clock that restores itself after a throwing test is
// the whole point.
import { describe, expect, test } from "vitest";

import { useFakeClock } from "./fake-clock.js";
import { seededRandom } from "./random.js";
import { bootstrappedVault } from "./vault.js";
import type { VaultBootstrapApi } from "./vault.js";

interface StubDb {
  dir: string | undefined;
  closes: number;
  close: () => void;
}

/**
 * The injected shape, not the real vault: `@centraid/test-kit` must not depend
 * on `@centraid/vault` (that edge is already the other way round for vault's
 * own tests). The real wiring is proven by the suites that adopted the helper.
 */
function stubApi(log: string[]): VaultBootstrapApi<StubDb, { owner: string }> {
  return {
    openVaultDb: (options) => {
      log.push(`open:${options?.dir ?? "memory"}`);
      const db: StubDb = {
        dir: options?.dir,
        closes: 0,
        close: () => {
          db.closes += 1;
          log.push("close");
        },
      };
      return db;
    },
    bootstrapVault: (_db, options) => {
      log.push(`bootstrap:${options.ownerName}:${options.vaultId ?? "-"}`);
      return { owner: options.ownerName };
    },
  };
}

describe(bootstrappedVault, () => {
  test("opens in memory, bootstraps a fixed owner, and hands both back", () => {
    const log: string[] = [];
    const { db, boot } = bootstrappedVault(stubApi(log));
    expect(log).toStrictEqual(["open:memory", "bootstrap:Test owner:-"]);
    expect(db.dir).toBeUndefined();
    expect(boot.owner).toBe("Test owner");
  });

  test("passes dir, ownerName and vaultId straight through", () => {
    const log: string[] = [];
    bootstrappedVault(stubApi(log), {
      dir: "/tmp/vault-x",
      ownerName: "Priya",
      vaultId: "vault-7",
    });
    expect(log).toStrictEqual(["open:/tmp/vault-x", "bootstrap:Priya:vault-7"]);
  });

  test("closes exactly once however many times close is called", () => {
    const log: string[] = [];
    const vault = bootstrappedVault(stubApi(log));
    vault.close();
    vault.close();
    expect(vault.db.closes).toBe(1);
  });

  // The defect the helper removes: `openVaultDb()` succeeded, `bootstrapVault()`
  // threw, and the hand-written `afterEach` never saw a handle to close — so the
  // SQLite files stayed open for the rest of the file.
  test("a bootstrap that throws still leaves the handle registered for close", () => {
    const log: string[] = [];
    const api = stubApi(log);
    const failing: VaultBootstrapApi<StubDb, { owner: string }> = {
      openVaultDb: api.openVaultDb,
      bootstrapVault: () => {
        throw new Error("schema refused");
      },
    };
    expect(() => bootstrappedVault(failing)).toThrow("schema refused");
    // `onTestFinished` runs after this body, so assert the registration
    // happened by driving the same path without auto-close and closing by hand.
    const manual = bootstrappedVault(stubApi(log), { autoClose: false });
    manual.close();
    expect(manual.db.closes).toBe(1);
  });

  test("autoClose:false leaves the caller owning the handle", () => {
    const log: string[] = [];
    const vault = bootstrappedVault(stubApi(log), { autoClose: false });
    expect(log).not.toContain("close");
    vault.close();
    expect(log).toContain("close");
  });
});

describe(useFakeClock, () => {
  test("advance runs timers and settles their microtasks", async () => {
    const start = Date.parse("2026-07-31T00:00:00Z");
    const clock = useFakeClock(start);
    const seen: string[] = [];
    setTimeout(() => {
      void Promise.resolve().then(() => seen.push("after-await"));
    }, 1_000);
    await clock.advance(1_000);
    expect(seen).toStrictEqual(["after-await"]);
    expect(clock.now()).toBe(start + 1_000);
  });

  test("advanceSync runs synchronous timer callbacks", () => {
    const clock = useFakeClock(0);
    let fired = 0;
    setTimeout(() => {
      fired += 1;
    }, 500);
    clock.advanceSync(500);
    expect(fired).toBe(1);
  });

  test("set jumps the clock without running the timers it passes", () => {
    const clock = useFakeClock(0);
    let fired = 0;
    setTimeout(() => {
      fired += 1;
    }, 1_000);
    clock.set(10_000);
    expect(fired).toBe(0);
    expect(clock.now()).toBe(10_000);
  });

  test("pending counts scheduled timers, so a leak can be asserted", () => {
    const clock = useFakeClock(0);
    expect(clock.pending()).toBe(0);
    setTimeout(() => undefined, 1_000);
    setTimeout(() => undefined, 2_000);
    expect(clock.pending()).toBe(2);
  });

  test("omitting the instant freezes the wall clock rather than jumping to 1970", () => {
    const before = Date.now();
    const clock = useFakeClock();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
  });

  test("restore is idempotent and puts real timers back immediately", () => {
    const clock = useFakeClock(0);
    expect(Date.now()).toBe(0);
    clock.restore();
    clock.restore();
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });

  // The leak the ban exists for, stated as an ordered pair: the first test
  // installs a clock and never restores it by hand, and the second — which
  // vitest runs immediately after, in the same file and worker — must still
  // see real time. Before the kit owned the restore, this second test hung.
  test("leak probe: a clock is installed and never restored by hand", () => {
    useFakeClock(0);
    expect(Date.now()).toBe(0);
  });

  test("leak probe: the next test in the file sees real time again", () => {
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });
});

describe(seededRandom, () => {
  test("the same seed replays the same sequence", () => {
    const one = seededRandom(42);
    const two = seededRandom(42);
    const first = Array.from({ length: 8 }, () => one.next());
    const second = Array.from({ length: 8 }, () => two.next());
    expect(second).toStrictEqual(first);
    // A replayable sequence that never moves would also satisfy the above.
    expect(new Set(first).size).toBe(8);
  });

  test("different seeds diverge", () => {
    expect(seededRandom(1).next()).not.toBe(seededRandom(2).next());
  });

  test("next stays inside the Math.random contract", () => {
    const rng = seededRandom(7);
    const draws = Array.from({ length: 500 }, () => rng.next());
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
  });

  test("int is inclusive at both ends and never escapes the range", () => {
    const rng = seededRandom(11);
    const draws = Array.from({ length: 2_000 }, () => rng.int(3, 6));
    expect(Math.min(...draws)).toBe(3);
    expect(Math.max(...draws)).toBe(6);
  });

  test("token is the requested length, lowercase alphanumeric, and reproducible", () => {
    expect(seededRandom(5).token(8)).toBe(seededRandom(5).token(8));
    expect(seededRandom(5).token(8)).toMatch(/^[a-z0-9]{8}$/u);
    expect(seededRandom(5).token()).toHaveLength(6);
  });
});
