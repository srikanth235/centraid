// governance: allow-repo-hygiene file-size-limit pre-existing cohesive route regression suite; decomposition is outside issue #417
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, afterEach, expect, test, vi } from "vitest";

import { Dispatcher, Registry } from "@centraid/server/engine";
import type { ToolResult } from "@centraid/server/engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { plainSqliteRow, plainSqliteRows } from "@centraid/test-kit/sqlite";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  readReplicaRow,
} from "@centraid/vault";

import { replicaDispatchOutcome } from "../serve/build-gateway.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { handleReplicaIntent } from "./replica-intent-route.js";
import type { ReplicaIntentDispatcher } from "./replica-intent-route.js";
import { buildReplicaShapes, shapeReplicaRow } from "./replica-shape.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("test value is not JSON-safe");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function intentHash(input: {
  appId: string;
  action: string;
  input: unknown;
  baseVersions?: unknown[];
}): string {
  return crypto.createHash("sha256").update(canonicalJson(input)).digest("hex");
}

describe("replica-intent-route suite", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`replica-intent-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    return opened;
  }

  function request(body: unknown): IncomingMessage {
    return Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: {},
      method: "POST",
      url: "/centraid/_vault/replica/intents",
    }) as unknown as IncomingMessage;
  }

  function response(): {
    res: ServerResponse;
    body: () => Record<string, unknown>;
  } {
    let output = "";
    const res = {
      statusCode: 0,
      setHeader: vi.fn<ServerResponse["setHeader"]>(),
      end: (value?: string) => {
        output = value ?? "";
      },
    } as unknown as ServerResponse;
    return { res, body: () => JSON.parse(output) as Record<string, unknown> };
  }

  function replicaInvocationId(intentId: string, ordinal: number): string {
    return `replica:v1:${crypto
      .createHash("sha256")
      .update(
        JSON.stringify(["centraid.replica-invocation.v1", intentId, ordinal])
      )
      .digest("hex")}`;
  }

  async function bridgeFinalizationFixture() {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "act" }],
    });
    const registryDir = await tempDir(
      `replica-intent-registry-${crypto.randomUUID()}-`
    );
    const codeDir = await tempDir(
      `replica-intent-code-${crypto.randomUUID()}-`
    );
    cleanups.push(
      () => fs.rm(registryDir, { recursive: true, force: true }),
      () => fs.rm(codeDir, { recursive: true, force: true })
    );
    await fs.mkdir(path.join(codeDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(codeDir, "app.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "planner",
        name: "Planner",
        version: "0.1.0",
        actions: [
          {
            name: "add_task",
            confirmation: "none",
            input: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                deny_second: { type: "boolean" },
                double: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        ],
        queries: [],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(codeDir, "actions", "add_task.js"),
      `export default async ({ body, ctx }) => {
       try {
         const title = String(body?.title ?? '');
         const invoke = (taskTitle, ordinal) => ctx.vault.invoke({ command: 'schedule.add_task', input: { title: taskTitle }, purpose: 'dpv:ServiceProvision', invocationId: 'handler-selected-' + ordinal });
         const first = await invoke(body?.double ? title + ' first' : title, 'first');
         if (body?.deny_second) {
           const denied = await ctx.vault.invoke({ command: 'knowledge.create_note', input: { title, body_text: title }, purpose: 'dpv:ServiceProvision', invocationId: 'handler-selected-second' });
           return { status: 200, body: denied };
         }
         const outcome = body?.double ? await invoke(title + ' second', 'second') : first;
         return { status: 200, body: outcome };
       } catch (err) { return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } }; }
     };\n`,
      "utf8"
    );
    const registry = new Registry(registryDir);
    await registry.load();
    await registry.ensureUploaded("planner");
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async () => codeDir,
      vaultFor: (appId) => vault.bridgeFor(appId),
    });
    const rawResults: ToolResult[] = [];
    const dispatch = vi.fn<ReplicaIntentDispatcher>(async (requestBody) => {
      const result = await dispatcher.write({
        app: requestBody.appId,
        action: requestBody.action,
        input: requestBody.input,
        intentId: requestBody.intentId,
      });
      rawResults.push(result);
      return replicaDispatchOutcome(result);
    });
    return {
      vault,
      rawResults,
      dispatch,
      context: {
        plane: vault,
        access: {
          canWrite: true,
          rememberDevice: true,
          deviceId: "device-bridge-finalization",
          appId: "planner",
        },
        dispatch,
      },
    };
  }

  test("a crash-left sending row deterministically re-dispatches, then terminal retry dedupes", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });
    const input = { title: "offline task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"offline task"}}'
      )
      .digest("hex");
    const identity = {
      intentId: "intent-retry-1",
      deviceId: "device-a",
      appId: "planner",
      action: "add_task",
      payloadHash,
    };
    recordReplicaIntentOutcome(vault.db.vault, {
      ...identity,
      status: "sending",
    });
    const dispatch = vi
      .fn<ReplicaIntentDispatcher>()
      .mockResolvedValue({ status: "executed", output: { taskId: "task-1" } });
    const body = {
      intentId: identity.intentId,
      appId: identity.appId,
      action: identity.action,
      input,
      payloadHash,
    };

    const first = response();
    await handleReplicaIntent(request(body), first.res, {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: identity.deviceId,
        appId: "planner",
      },
      dispatch,
    });
    expect(first.res.statusCode).toBe(200);
    expect(first.body()).toMatchObject({
      outcome: {
        intentId: identity.intentId,
        status: "executed",
        output: { taskId: "task-1" },
      },
    });
    expect(dispatch).toHaveBeenCalledOnce();

    const retry = response();
    await handleReplicaIntent(request(body), retry.res, {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: identity.deviceId,
        appId: "planner",
      },
      dispatch,
    });
    expect(retry.res.statusCode).toBe(200);
    expect(retry.body()).toMatchObject({ outcome: { status: "executed" } });
    expect(retry.body()).not.toHaveProperty("outcome.output");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("a foreign intent id looks in-flight and never dispatches or mutates its owner row", async () => {
    const vault = await plane();
    const input = { title: "collision probe" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"collision probe"}}'
      )
      .digest("hex");
    recordReplicaIntentOutcome(vault.db.vault, {
      intentId: "foreign-intent",
      deviceId: "device-owner",
      appId: "planner",
      action: "add_task",
      payloadHash,
      status: "sending",
    });
    const dispatch = vi.fn<ReplicaIntentDispatcher>();
    const result = response();

    await handleReplicaIntent(
      request({
        intentId: "foreign-intent",
        appId: "planner",
        action: "add_task",
        input,
        payloadHash,
      }),
      result.res,
      {
        plane: vault,
        access: {
          canWrite: true,
          rememberDevice: true,
          deviceId: "device-prober",
          appId: "planner",
        },
        dispatch,
      }
    );

    expect(result.res.statusCode).toBe(202);
    expect(result.body()).toMatchObject({
      accepted: true,
      outcome: { intentId: "foreign-intent", status: "in-flight" },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      readReplicaIntentOutcome(vault.db.vault, "foreign-intent", "device-owner")
    ).toMatchObject({
      status: "sending",
    });
  });

  test("a dispatch exception stays in-flight, then retry terminalizes without durable output", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });
    const input = { title: "ambiguous offline task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"ambiguous offline task"}}'
      )
      .digest("hex");
    const body = {
      intentId: "intent-ambiguous-1",
      appId: "planner",
      action: "add_task",
      input,
      payloadHash,
    };
    const dispatch = vi
      .fn<ReplicaIntentDispatcher>()
      .mockRejectedValueOnce(
        new Error("response channel closed after canonical commit")
      )
      .mockResolvedValueOnce({
        status: "executed",
        output: { secretDerivative: "must-not-be-durable" },
      });
    const context = {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: "device-ambiguous",
        appId: "planner",
      },
      dispatch,
    };

    const ambiguous = response();
    await handleReplicaIntent(request(body), ambiguous.res, context);
    expect(ambiguous.res.statusCode).toBe(202);
    expect(ambiguous.body()).toMatchObject({
      outcome: { status: "in-flight" },
    });
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        body.intentId,
        context.access.deviceId
      )
    ).toMatchObject({ status: "sending" });

    const retried = response();
    await handleReplicaIntent(request(body), retried.res, context);
    expect(retried.res.statusCode).toBe(200);
    expect(retried.body()).toMatchObject({
      outcome: {
        status: "executed",
        output: { secretDerivative: "must-not-be-durable" },
      },
    });
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        body.intentId,
        context.access.deviceId
      )
    ).not.toHaveProperty("output");
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(
            `SELECT count(*) AS n
           FROM pragma_table_info('replica_intent_outcome')
          WHERE name = 'output_json'`
          )
          .get()
      )
    ).toStrictEqual({ n: 0 });

    const terminalRetry = response();
    await handleReplicaIntent(request(body), terminalRetry.res, context);
    expect(terminalRetry.res.statusCode).toBe(200);
    expect(terminalRetry.body()).not.toHaveProperty("outcome.output");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test("a live replica response is redacted from the durable outcome and terminal replay", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "act" }],
    });

    const registryDir = await tempDir(
      `replica-intent-registry-${crypto.randomUUID()}-`
    );
    const codeDir = await tempDir(
      `replica-intent-code-${crypto.randomUUID()}-`
    );
    cleanups.push(
      () => fs.rm(registryDir, { recursive: true, force: true }),
      () => fs.rm(codeDir, { recursive: true, force: true })
    );
    await fs.mkdir(path.join(codeDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(codeDir, "app.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "planner",
        name: "Planner",
        version: "0.1.0",
        actions: [
          {
            name: "add_task",
            confirmation: "none",
            input: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                deny_second: { type: "boolean" },
                double: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        ],
        queries: [],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(codeDir, "actions", "add_task.js"),
      `export default async ({ body, ctx }) => {
       try {
         const title = String(body?.title ?? '');
         const invoke = (taskTitle, ordinal) => ctx.vault.invoke({
           command: 'schedule.add_task',
           input: { title: taskTitle },
           purpose: 'dpv:ServiceProvision',
           invocationId: 'handler-selected-' + ordinal,
         });
         const first = await invoke(body?.double ? title + ' first' : title, 'first');
         if (body?.deny_second) {
           const denied = await ctx.vault.invoke({
             command: 'knowledge.create_note',
             input: { title, body_text: title },
             purpose: 'dpv:ServiceProvision',
             invocationId: 'handler-selected-second',
           });
           return { status: 200, body: denied };
         }
         const outcome = body?.double ? await invoke(title + ' second', 'second') : first;
         return { status: 200, body: outcome };
       } catch (err) {
         return {
           status: 200,
           body: { status: 'denied', reason: err.message, code: err.code },
         };
       }
     };\n`,
      "utf8"
    );
    const registry = new Registry(registryDir);
    await registry.load();
    await registry.ensureUploaded("planner");
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async () => codeDir,
      vaultFor: (appId) => vault.bridgeFor(appId),
    });
    const rawResults: ToolResult[] = [];
    const dispatch = vi.fn<ReplicaIntentDispatcher>(async (requestBody) => {
      const result = await dispatcher.write({
        app: requestBody.appId,
        action: requestBody.action,
        input: requestBody.input,
        intentId: requestBody.intentId,
      });
      rawResults.push(result);
      return replicaDispatchOutcome(result);
    });
    const context = {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: "device-bridge-finalization",
        appId: "planner",
      },
      dispatch,
    };

    const liveInput = { title: "live output task" };
    const liveBody = {
      intentId: "intent-live-output-1",
      appId: "planner",
      action: "add_task",
      input: liveInput,
      payloadHash: crypto
        .createHash("sha256")
        .update(
          '{"action":"add_task","appId":"planner","input":{"title":"live output task"}}'
        )
        .digest("hex"),
    };
    const live = response();
    await handleReplicaIntent(request(liveBody), live.res, context);
    expect(live.res.statusCode).toBe(200);
    expect(live.body()).toMatchObject({
      outcome: { status: "executed", output: { task_id: expect.any(String) } },
    });
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        liveBody.intentId,
        context.access.deviceId
      )
    ).not.toHaveProperty("output");
    const liveReceipt = vault.db.audit
      .prepare(`SELECT detail_json FROM access_receipt WHERE invocation_id = ?`)
      .get(replicaInvocationId(liveBody.intentId, 0)) as {
      detail_json: string;
    };
    expect(JSON.parse(liveReceipt.detail_json)).not.toHaveProperty("output");
    const liveReplay = response();
    await handleReplicaIntent(request(liveBody), liveReplay.res, context);
    expect(liveReplay.res.statusCode).toBe(200);
    expect(liveReplay.body()).not.toHaveProperty("outcome.output");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("a bridge-finalization error stays retryable and replays exactly once", async () => {
    const { vault, rawResults, dispatch, context } =
      await bridgeFinalizationFixture();

    vault.db.audit.exec(`CREATE TEMP TRIGGER fail_replica_finalization_receipt
    BEFORE INSERT ON access_receipt BEGIN
      SELECT RAISE(ABORT, 'synthetic bridge finalization failure');
    END`);
    const input = { title: "ambiguous bridge task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"ambiguous bridge task"}}'
      )
      .digest("hex");
    const body = {
      intentId: "intent-bridge-finalization-1",
      appId: "planner",
      action: "add_task",
      input,
      payloadHash,
    };

    const ambiguous = response();
    await handleReplicaIntent(request(body), ambiguous.res, context);

    expect(rawResults.at(0)).toMatchObject({
      isError: false,
      structuredContent: {
        status: "denied",
        code: "VAULT_ERROR",
        reason: expect.stringContaining(
          "synthetic bridge finalization failure"
        ),
      },
    });
    expect(ambiguous.res.statusCode).toBe(202);
    expect(ambiguous.body()).toMatchObject({
      outcome: { status: "in-flight" },
    });
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        body.intentId,
        context.access.deviceId
      )
    ).toMatchObject({ status: "sending" });
    const ambiguousMarker = vault.db.vault
      .prepare(
        `SELECT invocation_id, intent_id, journal_finalized_at
         FROM replica_invocation_commit WHERE intent_id = ?`
      )
      .get(body.intentId) as {
      invocation_id: string;
      intent_id: string;
      journal_finalized_at: string | null;
    };
    expect(ambiguousMarker).toMatchObject({
      intent_id: body.intentId,
      journal_finalized_at: null,
    });
    expect(ambiguousMarker.invocation_id).toMatch(/^replica:v1:[a-f0-9]{64}$/u);
    expect(ambiguousMarker.invocation_id).not.toBe("handler-selected-first");
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(`SELECT count(*) AS n FROM schedule_task WHERE title = ?`)
          .get(input.title)
      )
    ).toStrictEqual({ n: 1 });

    vault.db.audit.exec("DROP TRIGGER fail_replica_finalization_receipt");
    const retried = response();
    await handleReplicaIntent(request(body), retried.res, context);

    expect(rawResults.at(1)).toMatchObject({
      isError: false,
      structuredContent: { status: "replayed", output: null },
    });
    expect(retried.res.statusCode).toBe(200);
    expect(retried.body()).toMatchObject({ outcome: { status: "executed" } });
    expect(JSON.stringify(retried.body())).not.toContain("task_id");
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        body.intentId,
        context.access.deviceId
      )
    ).not.toHaveProperty("output");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(`SELECT count(*) AS n FROM schedule_task WHERE title = ?`)
          .get(input.title)
      )
    ).toStrictEqual({ n: 1 });
    expect(
      vault.db.vault
        .prepare(
          `SELECT 1 AS present FROM replica_invocation_commit WHERE intent_id = ?`
        )
        .get(body.intentId)
    ).toBeUndefined();
    expect(
      plainSqliteRow(
        vault.db.audit
          .prepare(
            `SELECT count(*) AS n FROM access_receipt WHERE invocation_id = ?`
          )
          .get(ambiguousMarker.invocation_id)
      )
    ).toStrictEqual({ n: 1 });
  });

  test("a later invocation finalization error replays the complete action exactly once", async () => {
    const { vault, rawResults, dispatch, context } =
      await bridgeFinalizationFixture();
    const multiInput = { title: "multi ambiguity", double: true };
    const multiBody = {
      intentId: "intent-multi-finalization-1",
      appId: "planner",
      action: "add_task",
      input: multiInput,
      payloadHash: crypto
        .createHash("sha256")
        .update(
          '{"action":"add_task","appId":"planner","input":{"double":true,"title":"multi ambiguity"}}'
        )
        .digest("hex"),
    };
    const multiInvocationIds = [
      replicaInvocationId(multiBody.intentId, 0),
      replicaInvocationId(multiBody.intentId, 1),
    ];
    vault.db.audit.exec(`CREATE TEMP TRIGGER fail_second_replica_finalization
    BEFORE INSERT ON access_receipt
    WHEN NEW.invocation_id = '${multiInvocationIds[1]}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic second invocation finalization failure');
    END`);

    const multiAmbiguous = response();
    await handleReplicaIntent(request(multiBody), multiAmbiguous.res, context);
    expect(rawResults.at(0)).toMatchObject({
      isError: false,
      structuredContent: {
        status: "denied",
        code: "VAULT_ERROR",
        reason: expect.stringContaining(
          "second invocation finalization failure"
        ),
      },
    });
    expect(multiAmbiguous.res.statusCode).toBe(202);
    expect(multiAmbiguous.body()).toMatchObject({
      outcome: { status: "in-flight" },
    });
    const multiMarkers = vault.db.vault
      .prepare(
        `SELECT invocation_id, journal_finalized_at
         FROM replica_invocation_commit WHERE intent_id = ?`
      )
      .all(multiBody.intentId) as unknown as Array<{
      invocation_id: string;
      journal_finalized_at: string | null;
    }>;
    expect(multiMarkers).toHaveLength(2);
    expect(
      multiMarkers.filter((marker) => marker.journal_finalized_at !== null)
    ).toHaveLength(1);
    expect(
      multiMarkers.filter((marker) => marker.journal_finalized_at === null)
    ).toHaveLength(1);
    expect(
      new Set(multiMarkers.map((marker) => marker.invocation_id))
    ).toStrictEqual(new Set(multiInvocationIds));
    expect(
      multiMarkers.every((marker) =>
        /^replica:v1:[a-f0-9]{64}$/u.test(marker.invocation_id)
      )
    ).toBe(true);
    expect(
      plainSqliteRows(
        vault.db.vault
          .prepare(
            `SELECT title, count(*) AS n FROM schedule_task
          WHERE title IN (?, ?) GROUP BY title ORDER BY title`
          )
          .all(`${multiInput.title} first`, `${multiInput.title} second`)
      )
    ).toStrictEqual([
      { title: `${multiInput.title} first`, n: 1 },
      { title: `${multiInput.title} second`, n: 1 },
    ]);

    vault.db.audit.exec("DROP TRIGGER fail_second_replica_finalization");
    const multiRetry = response();
    await handleReplicaIntent(request(multiBody), multiRetry.res, context);
    expect(multiRetry.res.statusCode).toBe(200);
    expect(multiRetry.body()).toMatchObject({
      outcome: { status: "executed" },
    });
    expect(multiRetry.body()).not.toHaveProperty("outcome.output");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      plainSqliteRows(
        vault.db.vault
          .prepare(
            `SELECT title, count(*) AS n FROM schedule_task
          WHERE title IN (?, ?) GROUP BY title ORDER BY title`
          )
          .all(`${multiInput.title} first`, `${multiInput.title} second`)
      )
    ).toStrictEqual([
      { title: `${multiInput.title} first`, n: 1 },
      { title: `${multiInput.title} second`, n: 1 },
    ]);
    const multiReceipts = vault.db.audit
      .prepare(
        `SELECT invocation_id, count(*) AS n FROM access_receipt
        WHERE invocation_id IN (?, ?) GROUP BY invocation_id`
      )
      .all(...multiInvocationIds) as unknown as Array<{
      invocation_id: string;
      n: number;
    }>;
    expect(multiReceipts).toHaveLength(2);
    expect(multiReceipts.every((receipt) => receipt.n === 1)).toBe(true);
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(
            `SELECT count(*) AS n FROM replica_invocation_commit WHERE intent_id = ?`
          )
          .get(multiBody.intentId)
      )
    ).toStrictEqual({ n: 0 });
    const multiTerminalRetry = response();
    await handleReplicaIntent(
      request(multiBody),
      multiTerminalRetry.res,
      context
    );
    expect(multiTerminalRetry.res.statusCode).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test("a post-invoke denial is durable and does not re-dispatch on retry", async () => {
    const { vault, rawResults, dispatch, context } =
      await bridgeFinalizationFixture();
    const postInvokeInput = { title: "partial denial task", deny_second: true };
    const postInvokeBody = {
      intentId: "intent-post-invoke-failure-1",
      appId: "planner",
      action: "add_task",
      input: postInvokeInput,
      payloadHash: crypto
        .createHash("sha256")
        .update(
          '{"action":"add_task","appId":"planner","input":{"deny_second":true,"title":"partial denial task"}}'
        )
        .digest("hex"),
    };

    const postInvokeFailure = response();
    await handleReplicaIntent(
      request(postInvokeBody),
      postInvokeFailure.res,
      context
    );
    expect(rawResults.at(0)).toMatchObject({
      isError: false,
      structuredContent: {
        status: "denied",
        reason: expect.stringContaining("no grant_scope covers knowledge"),
      },
    });
    expect(postInvokeFailure.res.statusCode).toBe(200);
    expect(postInvokeFailure.body()).toMatchObject({
      outcome: {
        status: "denied",
        reason: expect.stringContaining("no grant_scope covers knowledge"),
      },
    });
    expect(
      readReplicaIntentOutcome(
        vault.db.vault,
        postInvokeBody.intentId,
        context.access.deviceId
      )
    ).toMatchObject({
      status: "denied",
      reason: expect.stringContaining("no grant_scope covers knowledge"),
    });
    expect(
      plainSqliteRow(
        vault.db.vault
          .prepare(`SELECT count(*) AS n FROM schedule_task WHERE title = ?`)
          .get(postInvokeInput.title)
      )
    ).toStrictEqual({ n: 1 });

    expect(
      vault.db.vault
        .prepare(
          `SELECT 1 AS present FROM replica_invocation_commit WHERE intent_id = ?`
        )
        .get(postInvokeBody.intentId)
    ).toBeUndefined();
    expect(
      plainSqliteRow(
        vault.db.audit
          .prepare(
            `SELECT count(*) AS n FROM access_receipt WHERE invocation_id = ?`
          )
          .get(replicaInvocationId(postInvokeBody.intentId, 0))
      )
    ).toStrictEqual({ n: 1 });

    const postInvokeTerminalRetry = response();
    await handleReplicaIntent(
      request(postInvokeBody),
      postInvokeTerminalRetry.res,
      context
    );
    expect(postInvokeTerminalRetry.res.statusCode).toBe(200);
    expect(postInvokeTerminalRetry.body()).toMatchObject({
      outcome: { status: "denied" },
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("read-only policy denial is a durable outcome, not a revocation-shaped 403", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });
    const input = { title: "blocked task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"blocked task"}}'
      )
      .digest("hex");
    const dispatch = vi.fn<ReplicaIntentDispatcher>();
    const reply = response();

    await handleReplicaIntent(
      request({
        intentId: "readonly-1",
        appId: "planner",
        action: "add_task",
        input,
        payloadHash,
      }),
      reply.res,
      {
        plane: vault,
        access: {
          canWrite: false,
          rememberDevice: true,
          deviceId: "device-readonly",
          appId: "planner",
        },
        dispatch,
      }
    );

    expect(reply.res.statusCode).toBe(200);
    expect(reply.body()).toMatchObject({ outcome: { status: "denied" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("checks opaque row versions before dispatching an offline edit", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        {
          schema: "schedule",
          table: "task",
          verbs: "read+act",
          fieldMask: ["title"],
        },
      ],
    });
    vault.db.vault
      .prepare(
        `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
         VALUES ('opaque-conflict', ?, 'Before', 'needs-action', 0)`
      )
      .run(vault.boot.ownerPartyId);
    const access = {
      canWrite: true,
      rememberDevice: true,
      deviceId: "device-opaque-conflict",
      appId: "planner",
    };
    const shape = buildReplicaShapes(vault.db.vault, access).find((item) =>
      item.entityMap.has("schedule.task")
    )!;
    expect(shape.entityMap.get("schedule.task")?.primaryKey).toBe(
      "__centraid_row_id"
    );
    const before = shapeReplicaRow(
      shape,
      "schedule.task",
      readReplicaRow(vault.db.vault, "schedule.task", "opaque-conflict")!
    )!;
    const version = readReplicaRow(
      vault.db.vault,
      "schedule.task",
      "opaque-conflict"
    )!.rowVersion!;
    vault.db.vault
      .prepare(
        `UPDATE schedule_task SET title = 'After' WHERE task_id = 'opaque-conflict'`
      )
      .run();

    const input = { title: "offline edit" };
    const baseVersions = [
      {
        shapeId: shape.shapeId,
        entity: "schedule.task",
        rowId: before.rowId,
        version,
      },
    ];
    const dispatch = vi.fn<ReplicaIntentDispatcher>();
    const reply = response();
    await handleReplicaIntent(
      request({
        intentId: "opaque-conflict-1",
        appId: "planner",
        action: "edit_task",
        input,
        baseVersions,
        payloadHash: intentHash({
          appId: "planner",
          action: "edit_task",
          input,
          baseVersions,
        }),
      }),
      reply.res,
      { plane: vault, access, dispatch }
    );

    expect(reply.res.statusCode).toBe(200);
    expect(reply.body()).toMatchObject({
      outcome: {
        status: "conflict",
        conflict: {
          shapeId: shape.shapeId,
          entity: "schedule.task",
          rowId: before.rowId,
          expectedVersion: version,
          actualVersion: expect.any(Number),
        },
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("owner role may act — it is full plus admin, not a lesser tier", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });
    const input = { title: "owner task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"owner task"}}'
      )
      .digest("hex");
    const dispatch = vi
      .fn<ReplicaIntentDispatcher>()
      .mockResolvedValue({ status: "executed" });
    const reply = response();

    await handleReplicaIntent(
      request({
        intentId: "owner-1",
        appId: "planner",
        action: "add_task",
        input,
        payloadHash,
      }),
      reply.res,
      {
        plane: vault,
        access: {
          canWrite: true,
          rememberDevice: false,
          deviceId: "device-owner",
          appId: "planner",
        },
        dispatch,
      }
    );

    expect(reply.res.statusCode).toBe(200);
    expect(reply.body()).toMatchObject({ outcome: { status: "executed" } });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("act-only consent reaches the canonical dispatcher without requiring a read shape", async () => {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "act" }],
    });
    const input = { title: "private offline task" };
    const payloadHash = crypto
      .createHash("sha256")
      .update(
        '{"action":"add_task","appId":"planner","input":{"title":"private offline task"}}'
      )
      .digest("hex");
    const dispatch = vi
      .fn<ReplicaIntentDispatcher>()
      .mockResolvedValue({ status: "executed" });
    const reply = response();

    await handleReplicaIntent(
      request({
        intentId: "act-only-1",
        appId: "planner",
        action: "add_task",
        input,
        payloadHash,
      }),
      reply.res,
      {
        plane: vault,
        access: {
          canWrite: true,
          rememberDevice: false,
          deviceId: "device-act-only",
          appId: "planner",
        },
        dispatch,
      }
    );

    expect(reply.res.statusCode).toBe(200);
    expect(reply.body()).toMatchObject({ outcome: { status: "executed" } });
    expect(dispatch).toHaveBeenCalledWith({
      intentId: "act-only-1",
      appId: "planner",
      action: "add_task",
      input,
    });
  });
});
