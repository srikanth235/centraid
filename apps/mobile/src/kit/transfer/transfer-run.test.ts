import { describe, expect, it, vi } from "vitest";

import { TransferSourceUnavailableError, runTransfers } from "./transfer-run";
import type { TransferEntry, TransferSend } from "./transfer-run";

interface Record_ {
  kind: string;
}

function entry(
  id: string,
  sends: Array<TransferSend<Record_>>
): TransferEntry<Record_> {
  return { id, app: "photos", open: () => Promise.resolve(sends) };
}

function send(localUri: string): TransferSend<Record_> {
  return {
    bytes: { localUri, mediaType: "image/jpeg", plaintextSize: 1 },
    record: { kind: "photo" },
  };
}

function absent(id: string): TransferEntry<Record_> {
  return {
    id,
    app: "photos",
    open: () =>
      Promise.reject(new TransferSourceUnavailableError("not on this device")),
  };
}

describe(runTransfers, () => {
  it("sends every source of every entry, in order", async () => {
    const seen: string[] = [];
    const outcome = await runTransfers(
      [
        entry("a", [send("file:///a.jpg")]),
        entry("b", [send("file:///b.jpg"), send("file:///b.mov")]),
      ],
      {
        onProgress: () => undefined,
        send: (one) => {
          seen.push(one.bytes.localUri);
          return Promise.resolve();
        },
      }
    );
    expect(seen).toStrictEqual([
      "file:///a.jpg",
      "file:///b.jpg",
      "file:///b.mov",
    ]);
    expect(outcome.sent).toBe(3);
    expect(outcome.deferred.size).toBe(0);
    expect(outcome.pausedReason).toBeUndefined();
  });

  it("is serial: nothing starts before the previous send resolves", async () => {
    let inFlight = 0;
    let overlapped = false;
    await runTransfers(
      [
        entry("a", [send("a")]),
        entry("b", [send("b")]),
        entry("c", [send("c")]),
      ],
      {
        onProgress: () => undefined,
        send: async () => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          await Promise.resolve();
          inFlight -= 1;
        },
      }
    );
    expect(overlapped).toBe(false);
  });

  it("collects entries whose bytes are not on the device and carries on", async () => {
    const outcome = await runTransfers(
      [entry("a", [send("a")]), absent("b"), entry("c", [send("c")])],
      { onProgress: () => undefined, send: () => Promise.resolve() }
    );
    expect([...outcome.deferred]).toStrictEqual(["b"]);
    expect(outcome.sent).toBe(2);
    expect(outcome.pausedReason).toBeUndefined();
  });

  it("pauses on a real failure and keeps everything it already achieved", async () => {
    const outcome = await runTransfers(
      [entry("a", [send("a")]), absent("b"), entry("c", [send("c")])],
      {
        onProgress: () => undefined,
        send: vi
          .fn<(one: TransferSend<Record_>) => Promise<unknown>>()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("gateway went away")),
      }
    );
    expect(outcome.pausedReason).toBe("gateway went away");
    expect(outcome.sent).toBe(1);
    expect([...outcome.deferred]).toStrictEqual(["b"]);
  });

  it("carries the entry's target vault through to the producer", async () => {
    const targets: Array<string | undefined> = [];
    await runTransfers(
      [{ ...entry("a", [send("a")]), targetVaultId: "vault-1" }],
      {
        onProgress: () => undefined,
        send: (_one, from) => {
          targets.push(from.targetVaultId);
          return Promise.resolve();
        },
      }
    );
    expect(targets).toStrictEqual(["vault-1"]);
  });

  it("a non-Error thrown by a producer still reads as a reason", async () => {
    const outcome = await runTransfers([entry("a", [send("a")])], {
      onProgress: () => undefined,
      // oxlint-disable-next-line prefer-promise-reject-errors
      send: () => Promise.reject("nope"),
    });
    expect(outcome.pausedReason).toBe("nope");
  });
});
