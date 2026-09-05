/*
 * The batch boundary #922 B.1's ruling draws, and the crash window it may not
 * move. The host here is a fake `readBatch` with the same contract the gateway
 * gives it (opens once, commits in a `finally`, refuses to nest), because what
 * this file is about is WHEN the boundary falls, not what SQLite does inside
 * it — `read-batch.test.ts` in the vault owns that half.
 */

import { describe, expect, test } from "vitest";

import { createReadCoalescer } from "./vault-read-coalescer.js";
import type { ReadBatchHost } from "./vault-read-coalescer.js";

interface Recorder extends ReadBatchHost {
  /** One entry per opened transaction, holding the reads that committed in it. */
  readonly commits: string[][];
  /** Reads that ran outside any transaction, i.e. their own commit. */
  readonly solo: string[];
  open: boolean;
}

function recorder(options: { failCommit?: boolean } = {}): Recorder {
  const host: Recorder = {
    commits: [],
    solo: [],
    open: false,
    readBatch: <T>(body: () => T): T => {
      if (host.open) throw new Error("gateway read batch cannot nest");
      host.open = true;
      const slot: string[] = [];
      host.commits.push(slot);
      let value: T;
      try {
        value = body();
      } finally {
        host.open = false;
      }
      // The gateway commits in a `finally`; a COMMIT that throws must reach
      // the caller rather than a value whose receipts are not durable.
      if (options.failCommit) throw new Error("disk full at COMMIT");
      return value;
    },
  };
  return host;
}

/** A read that names itself, recording where it committed. */
function read(host: Recorder, name: string) {
  return () => {
    const slot = host.open ? host.commits.at(-1) : undefined;
    if (slot) slot.push(name);
    else host.solo.push(name);
    return { ok: true, result: name };
  };
}

describe("one durable commit per tool batch", () => {
  test("the reads of one turn commit together; a later turn is its own commit", async () => {
    const host = recorder();
    const coalesce = createReadCoalescer(host);

    const turnOne = await Promise.all([
      coalesce(read(host, "a")),
      coalesce(read(host, "b")),
      coalesce(read(host, "c")),
    ]);
    expect(turnOne.map((r) => r.result)).toStrictEqual(["a", "b", "c"]);
    expect(host.commits).toStrictEqual([["a", "b", "c"]]);

    // A SECOND model turn. The window closed with the first one, so nothing
    // was held across the await — which is the whole point of the ruling.
    await Promise.all([coalesce(read(host, "d")), coalesce(read(host, "e"))]);
    expect(host.commits).toStrictEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    expect(host.solo).toStrictEqual([]);
  });

  test("a read that arrives alone is its own commit and takes no write lock", async () => {
    const host = recorder();
    const coalesce = createReadCoalescer(host);
    await coalesce(read(host, "only"));
    expect(host.commits).toStrictEqual([]);
    expect(host.solo).toStrictEqual(["only"]);
  });

  test("every receipt is committed before its own reply settles", async () => {
    const host = recorder();
    const coalesce = createReadCoalescer(host);
    const settledWhileOpen: boolean[] = [];
    await Promise.all(
      ["a", "b"].map((name) =>
        coalesce(read(host, name)).then(() => {
          settledWhileOpen.push(host.open);
        })
      )
    );
    // THE CRASH WINDOW. A reply delivered while the transaction is still open
    // is a promise the vault has not yet made durable; a crash between the two
    // would lose the evidence for a read the handler already acted on.
    expect(settledWhileOpen).toStrictEqual([false, false]);
  });

  test("a COMMIT that fails tells every caller in the batch, and none of them ok", async () => {
    const host = recorder({ failCommit: true });
    const coalesce = createReadCoalescer(host);
    const results = await Promise.all([
      coalesce(read(host, "a")),
      coalesce(read(host, "b")),
    ]);
    expect(results.every((r) => r.ok)).toBe(false);
    expect(results[0]?.code).toBe("VAULT_ERROR");
    expect(results[0]?.error).toContain("disk full at COMMIT");
  });

  test("a batch that cannot open refuses rather than reading outside one", async () => {
    const host = recorder();
    host.open = true; // another writer holds the handle
    const coalesce = createReadCoalescer(host);
    const results = await Promise.all([
      coalesce(read(host, "a")),
      coalesce(read(host, "b")),
    ]);
    expect(results.every((r) => r.ok)).toBe(false);
    expect(results[0]?.error).toContain("cannot nest");
    // Nothing ran: `readBatch` throws before the body, so no read escaped the
    // boundary and no receipt landed outside a commit.
    expect(host.solo).toStrictEqual([]);
  });
});
