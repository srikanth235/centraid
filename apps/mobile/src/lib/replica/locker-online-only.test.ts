// THE ONLINE-ONLY LAW, ON THE PHONE.
//
// The sibling of `packages/blueprints/src/locker-online-only.test.ts`: that one
// proves the WRITE BUILDER stamps the rule on the two secret-bearing actions;
// this one proves the SEAT honours it. Both are needed, because the builder's
// flag is inert unless the transport reads it, and until this change the
// native session had no branch that did — `screens/Scan.tsx` put a card number
// through `session.write("locker", { action: "add-item" })` and it landed in
// the durable SQLite outbox.
//
// Three claims:
//
//  1. An online-only write goes STRAIGHT to the app's action handler and
//     leaves no durable trace — no intent, nothing in `pendingChanges`.
//  2. It FAILS rather than queueing when the gateway cannot be reached. There
//     is deliberately no fallback: falling back to the queue is precisely what
//     the flag forbids.
//  3. The one origin-seat caller that carries a secret — the card scanner —
//     passes the flag. Asserted over the source of `screens/scan-locker.ts`,
//     because a payload builder that quietly dropped it would be green
//     everywhere else.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ONLINE_ONLY_ACTIONS } from "@centraid/blueprints/apps/locker/writes";
import type {
  GatewayAuth,
  ReplicaCursor,
  ReplicaDigest,
  ReplicaIdFactory,
  VaultChangeMessage,
} from "@centraid/client/replica/native";

import type { NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const gatewayAuth: GatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  token: "t0ken",
  vaultId: "vault-a",
};

const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

function sequentialIds(): ReplicaIdFactory {
  let next = 0;
  return () => `intent-${++next}`;
}

const CURSOR: ReplicaCursor = { epoch: "replica-1", seq: 1 };

/** One complete windowed bootstrap page, with an empty catalog: this test
 *  never reads a row, and an empty catalog is also the honest first-open
 *  state a secret write must survive. */
function bootstrapPage(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor: CURSOR,
    rows: [],
    complete: true,
    shapes: [],
    shapeIds: [],
  };
}

function feed(): NativeChangeFeed {
  let listener: ((message: VaultChangeMessage) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async setShapeIds() {
      /* nothing to track */
    },
    async resume() {
      /* the coordinator only needs this to resolve */
    },
    setActive() {
      void listener;
    },
  };
}

interface Call {
  pathname: string;
  body: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function openSession(options: { actionFails?: boolean } = {}): Promise<{
  session: Awaited<ReturnType<typeof createNativeReplicaSession>>;
  calls: Call[];
}> {
  const calls: Call[] = [];
  const session = await createNativeReplicaSession({
    gatewayAuth: { ...gatewayAuth },
    changeFeed: feed(),
    driver: new NodeSqliteDriver(),
    digest: nodeDigest,
    idFactory: sequentialIds(),
    fetcher: (_base, pathname, init) => {
      calls.push({ pathname, body: String(init.body ?? "") });
      if (pathname.includes("/replica/bootstrap")) {
        return Promise.resolve(json(bootstrapPage()));
      }
      if (pathname.includes("/changes")) {
        return Promise.resolve(
          json({
            protocolVersion: 1,
            schemaEpoch: "schema-1",
            from: CURSOR,
            to: CURSOR,
            changes: [],
          })
        );
      }
      if (pathname.includes("/actions/")) {
        return options.actionFails
          ? Promise.reject(new Error("the gateway is unreachable"))
          : Promise.resolve(json({ item_id: "item-1" }));
      }
      return Promise.resolve(json({}));
    },
  });
  return { session, calls };
}

const SECRET = "4111 1111 1111 1111";

describe("Locker's online-only write door", () => {
  test("posts the action directly and leaves no durable trace", async () => {
    const { session, calls } = await openSession();
    try {
      const outcome = await session.write("locker", {
        action: "add-item",
        onlineOnly: true,
        input: { type: "card", title: "Card", card_number: SECRET },
      });
      expect(outcome.status).toBe("executed");

      const action = calls.find((call) =>
        call.pathname.includes("/centraid/locker/actions/add-item")
      );
      expect(action).toBeDefined();
      expect(action?.body).toContain("card_number");

      // The secret never travelled the intent rail.
      const intents = calls.filter((call) =>
        call.pathname.includes("/replica/intents")
      );
      expect(intents).toStrictEqual([]);
      await expect(session.pendingChanges()).resolves.toStrictEqual([]);
    } finally {
      await session.close();
    }
  });

  test("fails rather than queueing when the gateway cannot be reached", async () => {
    const { session } = await openSession({ actionFails: true });
    try {
      await expect(
        session.write("locker", {
          action: "add-item",
          onlineOnly: true,
          input: { type: "card", title: "Card", card_number: SECRET },
        })
      ).rejects.toThrow(/refused|unreachable/u);
      // The whole point: a refusal, not a durable row waiting for a connection.
      await expect(session.pendingChanges()).resolves.toStrictEqual([]);
    } finally {
      await session.close();
    }
  });

  test("the card scanner carries the flag on its Locker destination", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "..", "screens", "scan-locker.ts"),
      "utf8"
    );
    const lockerWrite = source.slice(source.indexOf('session.write("locker"'));
    expect(lockerWrite).not.toBe("");
    expect(lockerWrite).toContain("onlineOnly: true");
    expect(lockerWrite).toContain("card_number");
    expect(ONLINE_ONLY_ACTIONS).toContain("add-item");
  });
});
