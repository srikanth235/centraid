/*
 * What a queued write looks like on the phone before the gateway answers
 * (#883). Two failures on `NativeReplicaSession.write`, and both show up as
 * SILENCE rather than as a wrong answer: a write into a vault this phone does
 * not know the ORIGIN of carries no label and falls through to the shell's
 * generic sentence, and a first-open write admitted before this vault ever
 * bootstrapped is durable with an EMPTY projection nothing goes back for.
 */
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  pendingOverlayCopy,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { ReplicaRowEnvelope } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "./multi-vault-reader";
import type { NativeReplicaSession } from "./native-session";
import { createNativeReplicaSession, NOT_YET_SYNCED } from "./native-session";
import {
  createFeed,
  createGateway,
  json,
  noChanges,
  nodeDigest,
  sequentialIds,
} from "./native-session.test-fixtures";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import { UNNAMED_ORIGIN_LABEL, waitingOnLabel } from "./waiting-on";

const VAULT_ID = "vault-family";
const SHAPE_ID = "docs-default";

function bootstrapPage(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    vaultId: VAULT_ID,
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    rows: [],
    complete: true,
    shapeIds: [SHAPE_ID],
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: "docs",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: "core.document",
            primaryKey: "document_id",
            columns: [
              "document_id",
              "current_content_id",
              "title",
              "deleted_at",
            ],
          },
          {
            entity: "core.content_item",
            primaryKey: "content_id",
            columns: ["content_id", "title", "media_type"],
          },
        ],
      },
    ],
  };
}

interface Phone {
  root: string;
  session: NativeReplicaSession;
  reader: MultiVaultReplicaReader;
  setOnline: (next: boolean) => void;
}

let readerSeq = 0;

async function phone(options: {
  online: boolean;
  origin?: { displayName?: string };
  /** Reuse a previous phone's durable files: the relaunch case. */
  root?: string;
}): Promise<Phone> {
  const root = options.root ?? tempDirSync("centraid-pending-visibility-");
  const file = path.join(root, "vault.db");
  let online = options.online;
  const gateway = createGateway()
    .on("/replica/bootstrap", () => json(bootstrapPage()))
    .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:18789",
      gatewayId: "gateway-1",
      vaultId: VAULT_ID,
    },
    fetcher: gateway.fetcher,
    changeFeed: createFeed(),
    driver: new NodeSqliteDriver(file),
    isConnected: () => online,
    digest: nodeDigest,
    idFactory: sequentialIds(),
    ...(options.origin ? { origin: options.origin } : {}),
  });
  return {
    root,
    session,
    reader: new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, `mounted-${++readerSeq}.db`)),
      [
        {
          vaultId: VAULT_ID,
          label: "Family",
          canWrite: true,
          databaseName: file,
          personal: false,
        },
      ]
    ),
    setOnline: (next) => {
      online = next;
    },
  };
}

function documents(
  reader: MultiVaultReplicaReader
): Promise<ReplicaRowEnvelope[]> {
  return reader
    .read("docs", { entity: "core.document", limit: 10 })
    .then((result) => result.rows);
}

describe("the seat a queued write is waiting on", () => {
  // The label the origin sends (`peer-replica-intent-route.ts` fills
  // `waitingOn.label` from the link), which this mirrors before any reply.
  test.each([
    ["Priya", "Priya's device"],
    ["Priya  Menon\n", "Priya Menon's device"],
    ["Chris'", "Chris's device"],
    ["Ravi’s", "Ravi’s device"],
    ["Alex's", "Alex's device"],
    ["   ", UNNAMED_ORIGIN_LABEL],
    [undefined, UNNAMED_ORIGIN_LABEL],
  ])("%s reads as %s", (name, label) => {
    expect(waitingOnLabel(name)).toBe(label);
  });

  test("a queued write renders the waiting-on label before the gateway answers", async () => {
    const { session, reader, setOnline } = await phone({
      online: true,
      origin: { displayName: "Priya Menon" },
    });
    try {
      // Bootstrapped, then out of reach: admitted locally, gateway unasked.
      setOnline(false);
      const queued = await session.write("docs", {
        action: "upload",
        input: { title: "Beach day" },
      });
      expect(queued.status).toBe("queued");

      const [row] = await documents(reader);
      const pending = readPendingOverlay(row!.values);
      expect(pending?.stewardLabel).toBe("Priya Menon's device");
      // Queued still says the true thing about a queued row.
      expect(pendingOverlayCopy(pending!)).toBe("Waiting for a connection.");

      // The phone already carried the label; no round trip supplies it.
      await session.coordinator.applyIntentOutcome({
        intentId: queued.intentId,
        status: "parked",
        reason: "waiting for Priya Menon's device",
      });
      const [parked] = await documents(reader);
      expect(pendingOverlayCopy(readPendingOverlay(parked!.values)!)).toBe(
        "Waiting for Priya Menon's device."
      );
    } finally {
      reader.close();
      await session.close();
    }
  });

  test("a write into the member's own vault names nobody", async () => {
    const { session, reader, setOnline } = await phone({ online: true });
    try {
      setOnline(false);
      await session.write("docs", {
        action: "upload",
        input: { title: "Mine" },
      });
      const [row] = await documents(reader);
      expect(readPendingOverlay(row!.values)?.stewardLabel).toBeUndefined();
    } finally {
      reader.close();
      await session.close();
    }
  });
});

describe("a write admitted before this vault ever synced", () => {
  test("says it is not yet synced, then backfills its own projection", async () => {
    const { session, reader, setOnline } = await phone({ online: false });
    try {
      expect(session.catalog()).toHaveLength(0);
      const admitted = await session.write("docs", {
        action: "upload",
        input: { title: "First open" },
      });
      // NOT "waiting for a connection": that row is on screen; this one is not.
      expect(admitted.status).toBe("queued");
      expect("reason" in admitted && admitted.reason).toBe(NOT_YET_SYNCED);
      const [pending] = await session.pendingChanges();
      expect(pending?.reason).toBe(NOT_YET_SYNCED);
      // Durable, and drawing nothing — which is exactly what it said.
      await expect(documents(reader)).resolves.toHaveLength(0);

      setOnline(true);
      session.notifyReachable();
      await vi.waitFor(async () => {
        expect(session.catalog().length).toBeGreaterThan(0);
        await expect(documents(reader)).resolves.toHaveLength(1);
      });

      const [row] = await documents(reader);
      expect(row!.values.title).toBe("First open");
      const overlay = readPendingOverlay(row!.values);
      expect(overlay?.key).toBe(admitted.intentId);
      expect(overlay?.action).toBe("upload");
      // What is asserted is that the stand-in went, not that the row fell silent.
      const [settled] = await session.pendingChanges();
      expect(settled?.intentId).toBe(admitted.intentId);
      expect(settled?.reason).not.toBe(NOT_YET_SYNCED);
    } finally {
      reader.close();
      await session.close();
    }
  });

  test("a relaunch finishes a backfill the previous process never reached", async () => {
    const first = await phone({ online: false });
    let relaunched: Phone | undefined;
    try {
      const admitted = await first.session.write("docs", {
        action: "upload",
        input: { title: "Killed mid-first-open" },
      });
      await expect(documents(first.reader)).resolves.toHaveLength(0);

      // The catalog lands, and the process dies before anything redraws.
      first.setOnline(true);
      first.session.notifyReachable();
      await vi.waitFor(() => {
        expect(first.session.catalog().length).toBeGreaterThan(0);
      });
      first.reader.close();
      await first.session.close();

      // New process, no bootstrap: `start()` finishes from the catalog on disk.
      relaunched = await phone({ online: false, root: first.root });
      const [row] = await documents(relaunched.reader);
      expect(row?.values.title).toBe("Killed mid-first-open");
      expect(readPendingOverlay(row!.values)?.key).toBe(admitted.intentId);
    } finally {
      relaunched?.reader.close();
      await relaunched?.session.close();
    }
  });
});
