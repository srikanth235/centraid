/*
 * PHOTOGRAPHS QUEUED FOR TWO VAULTS, ON ONE PHONE (#1014, lane E).
 *
 * One phone holds two vaults and one upload queue. Before this umbrella that
 * queue was keyed by content alone, every gateway call was addressed to
 * whichever vault the gateway picks by default, and a settled follow-up was
 * written through the MOUNTED session whatever the row said — so a family
 * photograph queued while the phone was showing Personal landed, durably and
 * unrecoverably, in the personal vault.
 *
 * What is real here: the gateway process, both vaults, both seat files, both
 * replica sessions, the shipped upload ledger (its own SQLite file, its own
 * migrations) and the shipped follow-up replay. The BYTES' transport is the
 * one stand-in — a `DirectTransferClient` double that records the vault each
 * request was addressed to — because what is on trial is where a queued write
 * lands, not how a sealed part reaches a provider (`direct-transfers.test.ts`
 * owns that).
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { followupBelongsToSession } from "../../apps/mobile/src/lib/upload/followup-routing.js";
import type {
  DirectBeginInput,
  DirectBeginResult,
  DirectTransferClient,
  SettlementReceipt,
} from "../../apps/mobile/src/lib/upload/gateway-client.js";
import { DirectTransferError } from "../../apps/mobile/src/lib/upload/gateway-client.js";
import { NodeSqliteFileDriver } from "../../apps/mobile/src/lib/upload/node-sqlite-driver.js";
import { UploadQueueStore } from "../../apps/mobile/src/lib/upload/store.js";
import { UploadDrainer } from "../../apps/mobile/src/lib/upload/uploader.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { readEntity } from "./lib/reads.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Every request the phone made, with the vault it was addressed to. */
interface Addressed {
  sha256: string;
  vaultId?: string;
}

/**
 * The bytes' transport, recorded rather than performed. `refuse` makes one
 * content address answer 400 — terminal, the shape a gateway uses for a blob
 * it will not take — so the queue's failed surface can be asked about.
 */
function recordingClient(): DirectTransferClient & {
  addressed: Addressed[];
  refuse: Set<string>;
} {
  const addressed: Addressed[] = [];
  const refuse = new Set<string>();
  return {
    addressed,
    refuse,
    begin: (input: DirectBeginInput): Promise<DirectBeginResult> => {
      addressed.push({ sha256: input.sha256, vaultId: input.vaultId });
      if (refuse.has(input.sha256)) {
        return Promise.reject(
          new DirectTransferError("the vault refused these bytes", 400)
        );
      }
      return Promise.resolve({
        alreadyPresent: true,
        custody: "local-only",
        keyBase64: "",
        completedParts: [],
        settlement: { casAck: "receipt", custody: "local-only" },
      });
    },
    recordPart: () => Promise.resolve(),
    complete: (): Promise<SettlementReceipt> =>
      Promise.resolve({ casAck: "receipt" }),
  };
}

describe("two vaults, one phone, one upload queue", () => {
  let gateway: MobileGateway;
  let personal: MobileSeat;
  let family: MobileSeat;
  let familyVaultId: string;
  let store: UploadQueueStore;
  let driver: NodeSqliteFileDriver;
  const client = recordingClient();

  /** The ledger's own file, as on the phone — never the seat's. */
  function openStore(dataDir: string): void {
    driver = new NodeSqliteFileDriver(
      path.join(dataDir, "centraid-uploads.db")
    );
    store = UploadQueueStore.create(driver);
  }

  /**
   * The settled follow-ups this seat may write, and the ones waiting for the
   * other vault. The DECISION is the shipped one — `followupBelongsToSession`,
   * the leaf `replaySettledUploadFollowups` itself branches on; what the suite
   * supplies is the session to write through, because the replay module pulls
   * the phone's native derivative stack and this tier has no React Native.
   */
  async function replayThrough(
    seat: MobileSeat,
    vaultId: string
  ): Promise<{ replayed: number; waiting: Record<string, number> }> {
    const waiting: Record<string, number> = {};
    let replayed = 0;
    const followups = store.pendingFollowups();
    for (const followup of followups) {
      if (!followupBelongsToSession(followup.targetVaultId, vaultId)) {
        const other = followup.targetVaultId!;
        waiting[other] = (waiting[other] ?? 0) + 1;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await seat.session.write(followup.shape, {
        action: followup.action,
        input: followup.input as never,
        intentId: followup.intentId,
      });
      store.clearFollowup(followup.followupId);
      replayed += 1;
    }
    return { replayed, waiting };
  }

  /** Stage real bytes IN a named vault and queue the write that claims them. */
  async function queuePhotograph(
    text: string,
    vaultId: string,
    title: string
  ): Promise<string> {
    const bytes = Buffer.from(text, "utf8");
    const response = await fetch(`${gateway.url}/centraid/_vault/blobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
        "x-centraid-vault": vaultId,
      },
      body: JSON.stringify({
        base64: bytes.toString("base64"),
        filename: `${title}.txt`,
      }),
    });
    expect(response.ok, `staging ${title}`).toBe(true);
    const staged = (await response.json()) as { sha256: string };
    expect(staged.sha256).toBe(sha256(text));
    store.enqueueWithFollowup(
      {
        itemId: `item-${randomUUID()}`,
        sha256: staged.sha256,
        localUri: `file:///roll/${title}.txt`,
        targetVaultId: vaultId,
        mediaType: "text/plain",
        filename: `${title}.txt`,
        plaintextSize: bytes.length,
        sealedSize: bytes.length + 127,
        frameCount: 1,
        partCount: 1,
      },
      () => ({
        shape: "docs",
        action: "upload",
        input: { staged_sha: staged.sha256, title },
      })
    );
    return staged.sha256;
  }

  function drainer(): UploadDrainer {
    return new UploadDrainer({
      store,
      client,
      crypto: {} as never,
      openFile: () => {
        throw new Error("no byte path in this suite");
      },
      putPart: () => {
        throw new Error("no byte path in this suite");
      },
      gatewayBaseUrl: gateway.url,
    });
  }

  async function titlesIn(seat: MobileSeat): Promise<string[]> {
    await seat.session.pullNow();
    const { rows } = await readEntity(seat, "core.document");
    return rows
      .map((row) => String((row as Record<string, unknown>).title ?? ""))
      .sort();
  }

  beforeAll(async () => {
    gateway = await bootMobileGateway("two-vault-uploads");
    familyVaultId = await gateway.createVault("Family");
    personal = await openSeat(gateway, { label: "personal" });
    family = await openSeat(gateway, {
      label: "family",
      vaultId: familyVaultId,
    });
    openStore(gateway.dataDir);
  }, 90_000);

  afterAll(async () => {
    // The store owns the driver's handle; closing both would close it twice.
    store?.close();
    await personal?.close();
    await family?.close();
    await gateway?.close();
  });

  test("each queued photograph lands in the vault it was queued for", async () => {
    await queuePhotograph("a day at the lake", gateway.vaultId, "Lake");
    await queuePhotograph("the family table", familyVaultId, "Table");

    const summary = await drainer().drainOnce();
    expect(summary.failed).toBe(0);
    // P4: every request carried ITS item's vault, not one header for the queue.
    expect(
      [...client.addressed].map((call) => call.vaultId).sort()
    ).toStrictEqual([familyVaultId, gateway.vaultId].sort());

    // P2: the follow-up for the other vault is NOT written through this
    // session — it waits for the seat that holds it.
    const throughPersonal = await replayThrough(personal, gateway.vaultId);
    expect(throughPersonal.replayed).toBe(1);
    expect(throughPersonal.waiting[familyVaultId]).toBe(1);

    const throughFamily = await replayThrough(family, familyVaultId);
    expect(throughFamily.replayed).toBe(1);
    expect(throughFamily.waiting).toStrictEqual({});

    await expect(titlesIn(personal)).resolves.toStrictEqual(["Lake"]);
    await expect(titlesIn(family)).resolves.toStrictEqual(["Table"]);
  }, 60_000);

  test("a refused photograph is listed as failed, and a retry lands it", async () => {
    const sha = await queuePhotograph(
      "a refused frame",
      familyVaultId,
      "Refused"
    );
    client.refuse.add(sha);

    await drainer().drainOnce();
    // P7: a row that spent its attempts is on the failed list with its reason,
    // not silently gone from the pending set.
    const failed = store.failed();
    expect(failed.map((item) => item.sha256)).toStrictEqual([sha]);
    expect(failed[0]?.lastError).toContain("refused");
    expect(store.failedCount()).toBe(1);

    client.refuse.delete(sha);
    store.retry(failed[0]!.itemId);
    expect(store.failedCount()).toBe(0);
    const after = await drainer().drainOnce();
    expect(after.failed).toBe(0);

    await replayThrough(family, familyVaultId);
    await expect(titlesIn(family)).resolves.toStrictEqual(["Refused", "Table"]);
  }, 60_000);

  test("the same photograph queued for both vaults is two rows, not one", async () => {
    const text = "one picture, two homes";
    const first = await queuePhotograph(
      text,
      gateway.vaultId,
      "Shared-personal"
    );
    const second = await queuePhotograph(text, familyVaultId, "Shared-family");
    // P3: one content address, two target vaults, two rows. The global UNIQUE
    // key handed the second enqueue the FIRST row, so one of the two vaults
    // never got the picture at all.
    expect(first).toBe(second);
    expect(store.bySha(first, gateway.vaultId)?.itemId).not.toBe(
      store.bySha(first, familyVaultId)?.itemId
    );

    await drainer().drainOnce();
    await replayThrough(personal, gateway.vaultId);
    await replayThrough(family, familyVaultId);
    await expect(titlesIn(personal)).resolves.toStrictEqual([
      "Lake",
      "Shared-personal",
    ]);
    await expect(titlesIn(family)).resolves.toStrictEqual([
      "Refused",
      "Shared-family",
      "Table",
    ]);
  }, 60_000);
});
