// WHO A QUEUED WRITE IS WAITING FOR (#883, and #996 W5's half of it).
//
// A change saved into a vault the member does not OWN may have to wait for the
// person who does. The phone knows that at ADMISSION — it is a fact about the
// mount, not about the gateway's verdict — so the label rides the intent from
// the moment it is queued, and the sheet reads it in airplane mode where no
// verdict exists and will not for hours.
//
// WHAT THIS SUITE NO LONGER TESTS, and it is worth saying: a write admitted
// before the vault had a SHAPE CATALOG used to be durable with an EMPTY
// projection, and the session backfilled it when page one landed
// (`NOT_YET_SYNCED`). There is no catalog on a seat — a projection is the app's
// own, resolved from nothing — so a write always draws its row, and the state
// that sentence described cannot occur.

import path from "node:path";

import { describe, expect, test } from "vitest";

import { pendingOverlayCopy } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openNodeNativeSeat } from "./native-seat.test-fixtures";
import type { NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session-open";

const gatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-family",
};

function feed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

async function phone(options: { origin?: { displayName: string } } = {}) {
  const root = tempDirSync("waiting-on-");
  const seat = await openNodeNativeSeat({ path: path.join(root, "seat.db") });
  const session = await createNativeReplicaSession({
    gatewayAuth: { ...gatewayAuth },
    fetcher: () => Promise.reject(new Error("out of reach")),
    changeFeed: feed(),
    seat,
    // Out of reach: admitted locally, gateway unasked.
    isConnected: () => false,
    digest: (canonical: string) =>
      Promise.resolve(`digest:${canonical.length}`),
    idFactory: (() => {
      let n = 0;
      return () => `intent-${(n += 1)}`;
    })(),
    ...(options.origin ? { origin: options.origin } : {}),
  });
  return { session, seat };
}

describe("a queued write into someone else's vault", () => {
  test("carries the waiting-on label from admission", async () => {
    const { session, seat } = await phone({
      origin: { displayName: "Priya Menon" },
    });
    try {
      const queued = await session.write("docs", {
        action: "upload",
        input: { title: "Beach day" },
        optimistic: [
          {
            op: "upsert",
            entity: "core.document",
            rowId: "doc-1",
            values: { document_id: "doc-1", title: "Beach day" },
          },
        ],
      });
      expect(queued.status).toBe("queued");
      const [pending] = await session.pendingChanges();
      expect(pending?.status).toBe("queued");
      // THE PHONE ALREADY CARRIED IT: no round trip supplies this label, which
      // is the whole reason it is stamped at admission and stored with the
      // intent rather than read off a verdict.
      const [stored] = await seat.outbox().list();
      expect(stored?.stewardLabel).toBe("Priya Menon's device");
      // And the label is what the sheet SAYS once the gateway parks the change
      // on that person — the sentence the phone could not have written without
      // having carried the name since admission.
      expect(
        pendingOverlayCopy({
          status: "parked",
          stewardLabel: stored?.stewardLabel,
        } as never)
      ).toBe("Waiting for Priya Menon's device.");
    } finally {
      await session.close();
    }
  });

  test("a write into the member's own vault names nobody", async () => {
    const { session } = await phone();
    try {
      const queued = await session.write("docs", {
        action: "upload",
        input: { title: "Mine" },
        optimistic: [
          {
            op: "upsert",
            entity: "core.document",
            rowId: "doc-2",
            values: { document_id: "doc-2", title: "Mine" },
          },
        ],
      });
      expect(queued.status).toBe("queued");
      // A vault a member owns has nobody to wait for, and naming an owner
      // would be fiction.
      expect((await session.pendingChanges())[0]?.heldBadge).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
