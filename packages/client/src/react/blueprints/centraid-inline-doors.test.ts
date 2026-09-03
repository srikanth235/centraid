import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";

import type * as TypeImport_core from "../../gateway-client-core.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { installInlineCentraid } from "./centraid-inline.js";
import type {
  InlineCentraidClient,
  InstallInlineCentraidOptions,
} from "./centraid-inline.js";

const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof TypeImport_core.doFetch>(),
  readJson:
    vi.fn<(response: Response, operation: string) => Promise<unknown>>(),
}));
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_core.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: (token: string | undefined, ct?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ct ? { "Content-Type": ct } : {}),
  }),
  doFetch,
  readJson,
  VAULT_HEADER: "x-centraid-vault",
  enc: encodeURIComponent,
}));

const imports = vi.hoisted(() => ({
  vaultImportStage: vi.fn<(input: unknown) => Promise<unknown>>(),
  vaultImportsList: vi.fn<() => Promise<unknown>>(),
  vaultImportRows: vi.fn<(batchId: string) => Promise<unknown>>(),
  vaultImportPublish: vi.fn<(batchId: string) => Promise<unknown>>(),
  vaultImportDiscard: vi.fn<(batchId: string) => Promise<unknown>>(),
}));
vi.mock(
  import("../../gateway-client-vault-imports.js") as Promise<unknown>,
  () => imports
);

type Session = NonNullable<InstallInlineCentraidOptions["session"]>;

function fakeSession(): Session & { writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    read: vi.fn<Session["read"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "x" },
    })),
    search: vi.fn<Session["search"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "x" },
    })),
    write: vi.fn<Session["write"]>(async (_appId, input) => {
      writes.push(input);
      return { intentId: "gen-1", status: "executed" };
    }),
    subscribe: vi.fn<Session["subscribe"]>(
      (
        _appId,
        _deps,
        _listener: (inv: readonly ReplicaInvalidation[]) => void
      ) =>
        () =>
          undefined
    ),
  } as unknown as Session & { writes: unknown[] };
}

const noQueries: InlineAppModule["queries"] = {};

function mount(scopeId: string): {
  client: InlineCentraidClient;
  session: Session & { writes: unknown[] };
} {
  const session = fakeSession();
  const target: { centraid?: unknown } = {};
  installInlineCentraid({
    appId: "tally",
    queries: noQueries,
    target,
    ...(scopeId
      ? {
          scopes: [
            {
              scope: { id: scopeId, label: "Priya", canWrite: true },
              session,
            },
          ],
        }
      : { session }),
  });
  return { client: target.centraid as InlineCentraidClient, session };
}

describe("decideCommonsIntent — the steward's per-intent answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is feature-detectable as a function rather than probed by calling it", () => {
    const { client } = mount("steward-vault");
    expect(client.decideCommonsIntent).toBeTypeOf("function");
  });

  it("posts the decide path with the deciding seat, the verb and the steward's words", async () => {
    const { client } = mount("steward-vault");
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({
      intentId: "intent-1",
      grantId: "grant-1",
      decision: "decline",
      status: "denied",
      decided: true,
      reason: "not a group expense",
      receiptId: "rcpt-1",
    });

    const answer = await client.decideCommonsIntent!({
      intentId: "intent-1",
      decision: "decline",
      reason: "not a group expense",
    });

    expect(doFetch.mock.calls).toStrictEqual([
      [
        "https://gw.test",
        "/centraid/_gateway/commons/intents/intent-1/decide",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer tok",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            actorVaultId: "steward-vault",
            decision: "decline",
            reason: "not a group expense",
          }),
        },
      ],
    ]);
    expect(answer).toMatchObject({ decided: true, status: "denied" });
  });

  it("omits an absent reason instead of sending an empty one, and encodes the id", async () => {
    const { client } = mount("steward-vault");
    doFetch.mockResolvedValue(new Response("{}"));
    readJson.mockResolvedValue({ decided: true });

    await client.decideCommonsIntent!({
      intentId: "intent/2",
      decision: "approve",
    });

    expect(doFetch.mock.calls).toStrictEqual([
      [
        "https://gw.test",
        "/centraid/_gateway/commons/intents/intent%2F2/decide",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer tok",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            actorVaultId: "steward-vault",
            decision: "approve",
          }),
        },
      ],
    ]);
  });

  it("refuses on an ambient scope that cannot name the seat answering", async () => {
    const { client } = mount("");
    await expect(
      client.decideCommonsIntent!({ intentId: "intent-1", decision: "approve" })
    ).rejects.toThrow(/named vault scope/u);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("the staged-import bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers all five doors as functions", () => {
    const { client } = mount("owner-vault");
    for (const door of [
      client.stageImport,
      client.importBatches,
      client.importRows,
      client.publishImport,
      client.discardImport,
    ])
      expect(door).toBeTypeOf("function");
  });

  it("sends a CSV as text and never presents it to the replica session", async () => {
    const { client, session } = mount("owner-vault");
    imports.vaultImportStage.mockResolvedValue({ batchId: "batch-1" });

    await client.stageImport!(
      new File(["name,amount\nFerry,900\n"], "rows.csv", { type: "text/csv" })
    );

    expect(imports.vaultImportStage.mock.calls).toStrictEqual([
      [{ filename: "rows.csv", text: "name,amount\nFerry,900\n" }],
    ]);
    expect(session.write).not.toHaveBeenCalled();
    expect(session.writes).toStrictEqual([]);
  });

  it("sends anything the spine reads as bytes base64-encoded", async () => {
    const { client } = mount("owner-vault");
    imports.vaultImportStage.mockResolvedValue({ batchId: "batch-2" });

    await client.stageImport!(
      new File([new Uint8Array([0, 1, 2, 253])], "takeout.zip", {
        type: "application/zip",
      })
    );

    expect(imports.vaultImportStage.mock.calls).toStrictEqual([
      [
        {
          filename: "takeout.zip",
          base64: btoa(String.fromCharCode(0, 1, 2, 253)),
        },
      ],
    ]);
  });

  it("refuses a file past the gateway's own ceiling before reading it", async () => {
    const { client } = mount("owner-vault");
    const huge = new File(["x"], "huge.zip");
    Object.defineProperty(huge, "size", { value: 128 * 1024 * 1024 + 1 });

    await expect(client.stageImport!(huge)).rejects.toThrow(/imports stop at/u);
    expect(imports.vaultImportStage).not.toHaveBeenCalled();
  });

  it("refuses to stage while offline rather than queueing a file's plaintext", async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: "locker",
      queries: noQueries,
      target,
      session,
      isOnline: () => false,
    });
    const client = target.centraid as InlineCentraidClient;

    await expect(
      client.stageImport!(new File(["a,b"], "rows.csv"))
    ).rejects.toThrow(/never queued offline/u);
    expect(imports.vaultImportStage).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
  });

  it("delegates list, rows, publish and discard to the owner transports", async () => {
    const { client } = mount("owner-vault");
    imports.vaultImportsList.mockResolvedValue([{ batchId: "batch-1" }]);
    imports.vaultImportRows.mockResolvedValue([{ seq: 1 }]);
    imports.vaultImportPublish.mockResolvedValue({ created: 2 });
    imports.vaultImportDiscard.mockResolvedValue({ receiptId: "rcpt-9" });

    await expect(client.importBatches!()).resolves.toStrictEqual([
      { batchId: "batch-1" },
    ]);
    await expect(client.importRows!("batch-1")).resolves.toStrictEqual([
      { seq: 1 },
    ]);
    await expect(client.publishImport!("batch-1")).resolves.toStrictEqual({
      created: 2,
    });
    await expect(client.discardImport!("batch-1")).resolves.toStrictEqual({
      receiptId: "rcpt-9",
    });

    expect(imports.vaultImportsList.mock.calls).toStrictEqual([[]]);
    expect(imports.vaultImportRows.mock.calls).toStrictEqual([["batch-1"]]);
    expect(imports.vaultImportPublish.mock.calls).toStrictEqual([["batch-1"]]);
    expect(imports.vaultImportDiscard.mock.calls).toStrictEqual([["batch-1"]]);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
