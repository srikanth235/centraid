// `window.centraid.locker` (#996, R13 / W6-D2). The claims under test are the
// ones the ruling is about: an app gets plaintext and never the key, a locked
// door answers rather than prompts, and a reveal that could not be recorded
// is not a reveal.
import { describe, expect, test, vi } from "vitest";

import { createLockerKitDoor } from "./locker-kit-door.js";
import { encryptLockerSecret } from "./locker-secret.js";
import { LockerSession } from "./locker-unlock.js";
import { memoryWrappedKeyStore } from "./wrapped-key-store.js";

interface Row {
  keyId: string | null;
  values: Record<string, string>;
}

const KEY = new Uint8Array(32).fill(6);
const PASSPHRASE = "correct horse battery staple";

async function door(
  opts: {
    now?: () => number;
    recordReveal?: (r: unknown) => Promise<{ receiptId?: string }>;
  } = {}
) {
  const store = memoryWrappedKeyStore();
  const session = new LockerSession({
    store,
    vaultId: "v-1",
    ...(opts.now ? { now: opts.now } : {}),
  });
  await session.enroll(PASSPHRASE, { keyId: "k-1", key: KEY });
  const rows = new Map<string, Row>([
    [
      "item-1",
      {
        keyId: "k-1",
        values: {
          password: await encryptLockerSecret(
            { keyId: "k-1", key: KEY },
            "item-1",
            "hunter2-Corr3ct"
          ),
        },
      },
    ],
  ]);
  const recordReveal = vi.fn<
    (request: unknown) => Promise<{ receiptId?: string }>
  >(opts.recordReveal ?? (async () => ({ receiptId: "rcpt-1" })));
  const readRow = vi.fn<(request: { rowId: string }) => Promise<Row | null>>(
    async ({ rowId }) => rows.get(rowId) ?? null
  );
  return {
    rows,
    session,
    recordReveal,
    readRow,
    kit: createLockerKitDoor({ session, readRow, recordReveal }),
  };
}

describe("locker-kit-door", () => {
  test("the door hands over plaintext and no way to reach the key", async () => {
    const { kit, session } = await door();
    await session.unlock(PASSPHRASE);
    const answer = await kit.reveal({ rowId: "item-1" });
    expect(answer).toStrictEqual({
      ok: true,
      rowId: "item-1",
      values: { password: "hunter2-Corr3ct" },
      receiptId: "rcpt-1",
    });
    // The surface an app sees: three methods, none of which is the key. An
    // app that could read `K` could exfiltrate it, and no receipt would
    // record that, because nothing was revealed.
    expect(Object.keys(kit).toSorted()).toStrictEqual([
      "reveal",
      "state",
      "subscribeLock",
    ]);
    expect(JSON.stringify(kit)).not.toContain("key");
  });

  test("a locked door answers; it does not prompt and it does not read", async () => {
    const { kit, readRow } = await door();
    const answer = await kit.reveal({ rowId: "item-1" });
    expect(answer).toMatchObject({ ok: false, reason: "locked" });
    // Nothing was read and nothing was recorded: a door that could raise the
    // passphrase prompt is a door that can be used to phish it, so the app
    // renders the SHELL's lock surface instead.
    expect(readRow).not.toHaveBeenCalled();
  });

  test("the receipt is written BEFORE the plaintext is handed over", async () => {
    // `gateway.reveal` wrote its journal row inside the transaction that
    // produced the value. The boundary moved; the ordering must not, or a
    // reveal whose receipt failed is a reveal with no record.
    const { kit, session } = await door({
      recordReveal: async () => {
        throw new Error("intent queue is full");
      },
    });
    await session.unlock(PASSPHRASE);
    await expect(kit.reveal({ rowId: "item-1" })).rejects.toThrow(
      /intent queue is full/u
    );
  });

  test("a row under a key this device no longer holds is refused, not decrypted", async () => {
    const { kit, rows, session } = await door();
    await session.unlock(PASSPHRASE);
    rows.set("item-1", { ...rows.get("item-1")!, keyId: "k-2" });
    const answer = await kit.reveal({ rowId: "item-1" });
    expect(answer).toMatchObject({ ok: false, reason: "stale_key" });
    expect((answer as { message: string }).message).toContain(
      "re-enter this secret"
    );
  });

  test("a row that is not there is a named refusal, never an exception", async () => {
    const { kit, session } = await door();
    await session.unlock(PASSPHRASE);
    await expect(kit.reveal({ rowId: "nope" })).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  test("state and subscribeLock report the shell's lock, including expiry", async () => {
    let now = 0;
    const { kit, session } = await door({ now: () => now });
    const seen: string[] = [];
    const stop = kit.subscribeLock((state) => seen.push(state.status));
    expect(kit.state()).toMatchObject({ status: "locked", remainingMs: 0 });

    await session.unlock(PASSPHRASE);
    expect(kit.state().status).toBe("unlocked");
    expect(kit.state().remainingMs).toBeGreaterThan(0);

    // The clock is what ends a session, and nothing fires an event when it
    // does — which is why the door polls rather than waiting to be told.
    now = 10 * 60 * 1000;
    expect(kit.state()).toStrictEqual({ status: "locked", remainingMs: 0 });
    stop();
    expect(seen[0]).toBe("locked");
  });

  test("a deliberate reveal keeps the session alive", async () => {
    let now = 0;
    const { kit, session } = await door({ now: () => now });
    await session.unlock(PASSPHRASE);
    now = 4 * 60 * 1000;
    await kit.reveal({ rowId: "item-1" });
    now = 8 * 60 * 1000;
    // Idle is what ends a session, not elapsed time.
    expect(kit.state().status).toBe("unlocked");
  });
});
