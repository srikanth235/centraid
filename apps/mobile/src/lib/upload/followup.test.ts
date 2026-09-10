import { describe, expect, it, vi } from "vitest";

import type {
  MobileReplicaSession,
  NativeReplicaSession,
} from "../replica/native-session";
import type * as TypeImport_1mtgsk8 from "./derivatives-native";
import { replaySettledUploadFollowups } from "./followup";
import type { UploadQueue } from "./native-queue";
import type { UploadFollowup } from "./store";

vi.mock(import("./derivatives-native"), () => ({
  contributeDeviceDerivatives:
    vi.fn<typeof TypeImport_1mtgsk8.contributeDeviceDerivatives>(),
  cleanupDeviceDerivatives:
    vi.fn<typeof TypeImport_1mtgsk8.cleanupDeviceDerivatives>(),
}));

function followupOf(overrides: Partial<UploadFollowup> = {}): UploadFollowup {
  return {
    followupId: 7,
    intentId: "upload-followup-item-1-stable",
    itemId: "item-1",
    shape: "docs",
    action: "upload",
    input: { staged_sha: "a".repeat(64), title: "Field notes" },
    attempts: 0,
    ...overrides,
  };
}

/** A queue double whose follow-up list and poison ledger are plain arrays. */
function fakeQueue(pending: UploadFollowup[]) {
  const cleared: number[] = [];
  const poisoned: { id: number; reason: string }[] = [];
  const attempts = new Map<number, number>();
  const queue = {
    pendingFollowups: () =>
      pending.filter((f) => !poisoned.some((p) => p.id === f.followupId)),
    clearFollowup: (id: number) => {
      cleared.push(id);
      const index = pending.findIndex((f) => f.followupId === id);
      if (index >= 0) pending.splice(index, 1);
    },
    countFollowupAttempt: (id: number) => {
      const next = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, next);
      return next;
    },
    poisonFollowup: (id: number, reason: string) =>
      poisoned.push({ id, reason }),
  } as unknown as UploadQueue;
  return { queue, cleared, poisoned, attempts };
}

function okSession(): { session: NativeReplicaSession; writes: string[] } {
  const writes: string[] = [];
  const session = {
    write: vi.fn<NativeReplicaSession["write"]>(async (_shape, input) => {
      writes.push(input.intentId!);
      return { intentId: input.intentId!, status: "executed" as const };
    }),
  } as unknown as NativeReplicaSession;
  return { session, writes };
}

/** A session that answers for exactly one vault, as the real one does. */
function sessionForVault(vaultId: string): {
  session: MobileReplicaSession;
  write: ReturnType<typeof vi.fn<MobileReplicaSession["write"]>>;
} {
  const write = vi.fn<MobileReplicaSession["write"]>(async (_shape, input) => ({
    intentId: input.intentId!,
    status: "executed" as const,
  }));
  const session = {
    write,
    scope: () => ({ vaultId, label: vaultId, canWrite: true }),
  } as unknown as MobileReplicaSession;
  return { session, write };
}

describe("settled upload follow-ups", () => {
  // #1014 P2. #996 wave 3 read the `targetVaultId` stamp as history and wrote
  // every follow-up through the mounted session; on a phone that holds two
  // vaults that put the family photograph into the personal vault, and cleared
  // the follow-up on the way so nothing could ever put it right.
  it("does not write a follow-up into a vault the session does not hold", async () => {
    const { queue, cleared } = fakeQueue([
      followupOf({ targetVaultId: "vault-family" }),
    ]);
    const { session, write } = sessionForVault("vault-personal");

    const summary = await replaySettledUploadFollowups(
      queue,
      session,
      "http://gateway"
    );

    expect(write).not.toHaveBeenCalled();
    expect(cleared, "the record survives to be replayed later").toStrictEqual(
      []
    );
    expect(summary).toMatchObject({
      replayed: 0,
      poisoned: 0,
      waitingForVault: { "vault-family": 1 },
    });
  });

  it("writes a follow-up whose vault IS the session's", async () => {
    const { queue, cleared } = fakeQueue([
      followupOf({ targetVaultId: "vault-family" }),
    ]);
    const { session, write } = sessionForVault("vault-family");

    await replaySettledUploadFollowups(queue, session, "http://gateway");

    expect(write).toHaveBeenCalledOnce();
    expect(cleared).toStrictEqual([7]);
  });

  // A session double with no scope cannot answer "which vault"; the replay
  // then behaves as it always did rather than stalling every follow-up.
  it("replays through a session that names no vault", async () => {
    const { queue } = fakeQueue([
      followupOf({ targetVaultId: "vault-family" }),
    ]);
    const write = vi.fn<MobileReplicaSession["write"]>(
      async (_shape, input) => ({
        intentId: input.intentId!,
        status: "executed" as const,
      })
    );
    const session = { write } as unknown as MobileReplicaSession;

    await replaySettledUploadFollowups(queue, session, "http://gateway");

    expect(write).toHaveBeenCalledWith(
      "docs",
      expect.objectContaining({ intentId: "upload-followup-item-1-stable" })
    );
  });

  it("replays the same intent id after a kill between execution and ledger clearing", async () => {
    const followup = followupOf();
    let pending = [followup];
    let killBeforeFirstClear = true;
    const queue = {
      pendingFollowups: () => pending,
      clearFollowup: () => {
        if (killBeforeFirstClear) {
          killBeforeFirstClear = false;
          throw new Error("simulated process death after execution");
        }
        pending = [];
      },
      countFollowupAttempt: () => 1,
      poisonFollowup: () => undefined,
    } as unknown as UploadQueue;
    const writes: string[] = [];
    const createdDocuments = new Set<string>();
    const session = {
      write: vi.fn<NativeReplicaSession["write"]>(async (_shape, input) => {
        writes.push(input.intentId!);
        createdDocuments.add(input.intentId!);
        return { intentId: input.intentId!, status: "executed" as const };
      }),
    } as unknown as NativeReplicaSession;

    // The kill lands on the FIRST clear; the record is not cleared, so the next
    // pass replays the same intent (idempotent) rather than losing the work.
    await replaySettledUploadFollowups(queue, session, "http://gateway");
    await expect(
      replaySettledUploadFollowups(queue, session, "http://gateway")
    ).resolves.toStrictEqual({
      waitingForVault: {},
      replayed: 1,
      poisoned: 0,
    });

    expect(writes).toStrictEqual([followup.intentId, followup.intentId]);
    expect(
      createdDocuments.size,
      "the canonical document is created once"
    ).toBe(1);
    expect(pending).toStrictEqual([]);
  });

  it("isolates a poison-payload follow-up so the rest still replay (F4)", async () => {
    const poison = followupOf({
      followupId: 1,
      intentId: "poison",
      input: { title: "no sha" },
    });
    const good = followupOf({
      followupId: 2,
      intentId: "good",
      input: { staged_sha: "b".repeat(64), title: "ok" },
    });
    const { queue, poisoned } = fakeQueue([poison, good]);
    const { session, writes } = okSession();

    // Five passes: the poison never clears, but `good` replays on the first
    // pass and is gone thereafter; by pass five the poison is quarantined.
    let last = { replayed: 0, poisoned: 0 };
    const replayNextPass = async (pass: number): Promise<void> => {
      if (pass >= 5) return;
      last = await replaySettledUploadFollowups(
        queue,
        session,
        "http://gateway"
      );
      return replayNextPass(pass + 1);
    };
    await replayNextPass(0);

    expect(writes, "the healthy record replayed exactly once").toStrictEqual([
      "good",
    ]);
    expect(poisoned).toStrictEqual([
      { id: 1, reason: expect.stringMatching(/staged_sha/u) },
    ]);
    expect(last.poisoned).toBe(1);
  });

  it("poisons a follow-up whose canonical write keeps failing, without blocking others", async () => {
    const flaky = followupOf({ followupId: 1, intentId: "flaky" });
    const { queue, poisoned } = fakeQueue([flaky]);
    const session = {
      write: vi.fn<NativeReplicaSession["write"]>(async () => {
        throw new Error("replica rejected the write");
      }),
    } as unknown as NativeReplicaSession;

    const replayNextPass = async (pass: number): Promise<void> => {
      if (pass >= 5) return;
      await replaySettledUploadFollowups(queue, session, "http://gateway");
      return replayNextPass(pass + 1);
    };
    await replayNextPass(0);
    expect(poisoned).toStrictEqual([
      { id: 1, reason: expect.stringMatching(/replica rejected/u) },
    ]);
  });

  it("does not clear a denied canonical write as if it were accepted", async () => {
    const denied = followupOf({ followupId: 1, intentId: "denied" });
    const { queue, cleared, attempts } = fakeQueue([denied]);
    const session = {
      write: vi.fn<NativeReplicaSession["write"]>(async () => ({
        intentId: "denied",
        status: "denied",
        reason: "Tally receipt scope was not granted",
      })),
    } as unknown as NativeReplicaSession;

    await replaySettledUploadFollowups(queue, session, "http://gateway");

    expect(cleared).toStrictEqual([]);
    expect(attempts.get(1)).toBe(1);
  });
});
