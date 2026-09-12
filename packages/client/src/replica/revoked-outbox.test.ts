// WHAT A REVOKED SEAT OWES THE MEMBER (#1014, C25/P24; R-1014-12).
//
// Revocation is about the device's future access, not about the member's past
// writes. Both hosts used to delete the outbox with the file and tell the
// member only that the vault had been removed.

import { describe, expect, it } from "vitest";

import {
  revokedOutboxFileName,
  saveUnsentBeforePurge,
  serializeRevokedOutbox,
  unsentIntents,
} from "./revoked-outbox.js";
import type { IntentState, ReplicaIntent } from "./types.js";

function intent(intentId: string, state: IntentState): ReplicaIntent {
  return {
    intentId,
    createdOrder: 1,
    appId: "notes",
    action: "notes.create_note",
    input: { title: "made on a train" },
    payloadHash: `h-${intentId}`,
    state,
    attempts: 0,
    optimistic: [],
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("which intents a revocation owes the member", () => {
  it("keeps what the gateway never durably took, and only that", () => {
    const queue: ReplicaIntent[] = [
      intent("i-queued", "queued"),
      intent("i-sending", "sending"),
      intent("i-parked", "parked"),
      intent("i-failed", "failed"),
      intent("i-conflict", "conflict"),
      intent("i-base", "conflict-base-missing"),
      // The gateway committed these; only this seat's cursor is behind.
      intent("i-awaiting", "awaiting-change"),
      intent("i-executed", "executed"),
      intent("i-denied", "denied"),
      intent("i-expired", "expired"),
    ];
    expect(unsentIntents(queue).map((each) => each.intentId)).toStrictEqual([
      "i-queued",
      "i-sending",
      "i-parked",
      "i-failed",
      "i-conflict",
      "i-base",
    ]);
  });

  it("carries the input verbatim, which is the part nothing can rebuild", () => {
    const body = JSON.parse(
      serializeRevokedOutbox(
        "vault-1",
        [intent("i-1", "queued")],
        "2026-09-10T00:00:00.000Z"
      )
    ) as { vaultId: string; count: number; intents: ReplicaIntent[] };
    expect(body.vaultId).toBe("vault-1");
    expect(body.count).toBe(1);
    expect(body.intents[0]?.input).toStrictEqual({
      title: "made on a train",
    });
  });

  it("names one file per vault, escaped for a filesystem", () => {
    expect(revokedOutboxFileName("vault/../etc")).toBe(
      "revoked-outbox-vault%2F..%2Fetc.json"
    );
  });
});

describe("saving it before the file goes", () => {
  it("writes what is unsent and answers the count", async () => {
    const written: Array<[string, string]> = [];
    const saved = await saveUnsentBeforePurge({
      vaultId: "vault-1",
      intents: [intent("i-1", "queued"), intent("i-2", "executed")],
      sink: {
        write: (name, body) => {
          written.push([name, body]);
          return Promise.resolve();
        },
      },
    });
    expect(saved).toStrictEqual({ count: 1, saved: true });
    expect(written[0]?.[0]).toBe("revoked-outbox-vault-1.json");
  });

  it("still answers the count when there is nowhere to write it", async () => {
    // A host with no durable place must not report a clean removal: the count
    // is what the member is owed a sentence about either way.
    await expect(
      saveUnsentBeforePurge({
        vaultId: "vault-1",
        intents: [intent("i-1", "queued")],
        sink: undefined,
      })
    ).resolves.toStrictEqual({ count: 1, saved: false });
  });

  it("never abandons the purge because the export failed", async () => {
    await expect(
      saveUnsentBeforePurge({
        vaultId: "vault-1",
        intents: [intent("i-1", "queued")],
        sink: { write: () => Promise.reject(new Error("disk full")) },
      })
    ).resolves.toStrictEqual({ count: 1, saved: false });
  });

  it("is a no-op when nothing is owed", async () => {
    await expect(
      saveUnsentBeforePurge({
        vaultId: "vault-1",
        intents: [intent("i-1", "executed")],
        sink: {
          write: () => Promise.reject(new Error("must not be called")),
        },
      })
    ).resolves.toStrictEqual({ count: 0, saved: true });
  });
});
