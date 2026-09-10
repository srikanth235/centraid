// THE CHAIN, END TO END, IN THE WORDS THE SCREEN USES (#996, R23–R25).
//
// The acceptance row is one arc a member lives: five changes made with no
// radio, the app killed and relaunched, the radio back, and — because someone
// else edited the same row while this phone was away — a conflict on the head
// of the chain.
//
// Every piece of that has a home already: the outbox is `sqlite-intent-store`,
// the edges and the badge are `offline-chain.ts`, the states are the session's
// `pendingChanges()`, and the words are `kit/replica/pending-copy.ts`. What
// nothing joined up was the ARC — and an arc is where the seams are. This file
// runs it on one real file, through the production session, and asserts what
// the sheet would draw at each step.
//
// NOT A COMPONENT TEST. `PendingChangesSheet` renders `heldBadge` and
// `pendingChangeExplanation` directly; what is worth pinning is that the
// session hands them the right values after a restart and a conflict, which is
// the half a rendered tree would mock away.

import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { toPendingChanges } from "../../kit/replica/pending-change-rows";
import type { SessionPendingRow } from "../../kit/replica/pending-change-rows";
import {
  humanStatus,
  pendingChangeExplanation,
  pendingChangeVerbs,
} from "../../kit/replica/pending-copy";
import { openNodeNativeSeat } from "./native-seat.test-fixtures";
import type { NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session-open";

const gatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

/** A feed that carries nothing: this arc drives the session directly. */
function createFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

const nodeDigest = (canonical: string): Promise<string> =>
  Promise.resolve(`digest:${canonical.length}`);

function sequentialIds(): () => string {
  let n = 0;
  return () => `intent-${(n += 1)}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The other writer's edit landed while this phone was in the air. */
const SECOND_WRITER = {
  entity: "core.content_item",
  rowId: "content-1",
  expectedVersion: 7,
  actualVersion: 9,
};

describe("the offline chain's whole arc", () => {
  test("queued offline, redrawn after a relaunch, and refused by a second writer", async () => {
    const directory = tempDirSync("centraid-chain-journey");
    const file = path.join(directory, "replica.db");
    let online = false;
    let conflictHead: string | undefined;
    const fetcher = (
      _baseUrl: string,
      pathname: string,
      init: RequestInit
    ): Promise<Response> => {
      if (pathname.includes("/replica/intents")) {
        const sent = JSON.parse(String(init.body)) as { intentId: string };
        // THE SECOND WRITER, exactly where a real one lands: on the FIRST
        // intent of the chain, because that is the one holding a base version
        // observed before the flight.
        if (conflictHead === undefined) conflictHead = sent.intentId;
        return Promise.resolve(
          json({
            outcome:
              sent.intentId === conflictHead
                ? {
                    intentId: sent.intentId,
                    status: "conflict",
                    reason: "Someone else changed this first.",
                    conflict: { ...SECOND_WRITER },
                  }
                : { intentId: sent.intentId, status: "executed", commitSeq: 1 },
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    // ONE FILE, TWICE. The relaunch is the point of this arc: the second
    // session opens the SAME seat file and has to find the chain the first one
    // queued into `seat_outbox`.
    const open = async () =>
      createNativeReplicaSession({
        gatewayAuth: { ...gatewayAuth },
        fetcher,
        changeFeed: createFeed(),
        seat: await openNodeNativeSeat({ path: file }),
        digest: nodeDigest,
        idFactory: sequentialIds(),
        isConnected: () => online,
      });

    let session = await open();
    try {
      // ── Five changes, no radio ────────────────────────────────────────────
      const captions = [
        "Book the ferry",
        "Book the ferry (Tue)",
        "Ferry tickets",
      ];
      const first = await session.write("photos", {
        action: "photos.add_caption",
        input: { content_id: "content-1", caption: captions[0] as string },
      });
      const second = await session.write("photos", {
        action: "photos.add_caption",
        input: { content_id: "content-1", caption: captions[1] as string },
      });
      const third = await session.write("photos", {
        action: "photos.add_caption",
        input: { content_id: "content-1", caption: captions[2] as string },
      });
      const fourth = await session.write("photos", {
        action: "photos.favorite",
        input: { content_id: "content-1", favorite: true },
      });
      const fifth = await session.write("photos", {
        action: "photos.set_taken_at",
        input: { content_id: "content-1", taken_at: "2026-09-20" },
      });
      const queued = [first, second, third, fourth, fifth];
      for (const result of queued) expect(result.status).toBe("queued");

      const offline = toPendingChanges(
        (await session.pendingChanges()) as SessionPendingRow[],
        "Home"
      );
      expect(offline.map((change) => change.id)).toStrictEqual(
        queued.map((result) => result.intentId)
      );
      // Every one of them is a row a member may still take back, and none of
      // them is presented as broken.
      for (const change of offline) {
        expect(pendingChangeVerbs(change).cancel).toBe(true);
        expect(humanStatus(change.status)).not.toContain("Conflict");
      }

      // ── Killed and relaunched, still offline ──────────────────────────────
      await session.close();
      session = await open();
      const afterRestart = toPendingChanges(
        (await session.pendingChanges()) as SessionPendingRow[],
        "Home"
      );
      // THE CLAIM: nothing of the previous process survived except the file,
      // so these five rows and their order came off the durable outbox.
      expect(afterRestart.map((change) => change.id)).toStrictEqual(
        offline.map((change) => change.id)
      );

      // ── The radio returns, and someone else got there first ───────────────
      online = true;
      await session.flushIntents();
      const settled = toPendingChanges(
        (await session.pendingChanges()) as SessionPendingRow[],
        "Home"
      );
      const head = settled.find((change) => change.id === first.intentId);
      expect(head?.status).toBe("conflict");
      // BOTH VERSIONS, on the row, because a member choosing between Retry and
      // Discard is choosing between two states of the world and has to be told
      // which two.
      expect(head?.expectedVersion).toBe(SECOND_WRITER.expectedVersion);
      expect(head?.actualVersion).toBe(SECOND_WRITER.actualVersion);
      expect(pendingChangeExplanation(head!)).toContain(
        String(SECOND_WRITER.actualVersion)
      );
      const verbs = pendingChangeVerbs(head!);
      expect(verbs.retry).toBe(true);
      expect(verbs.discard).toBe(true);
    } finally {
      await session.close();
    }
  });
});
