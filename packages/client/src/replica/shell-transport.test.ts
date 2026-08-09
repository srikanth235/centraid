import { describe, expect, it, vi } from "vitest";

import type * as TypeImport_1n561g5 from "../gateway-client-core.js";
import { ReplicaRebootstrapRequiredError } from "./errors.js";
import {
  borrowedReplicaFetcher,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
} from "./shell-transport.js";
import type { ReplicaFetcher } from "./shell-transport.js";

vi.mock(import("../gateway-client-core.js"), () => ({
  // Explicit `Record<string, string>` return type (matching the real
  // `authHeaders`) so the empty-object branch isn't narrowed to
  // `{ Authorization?: undefined }`, which isn't assignable to it.
  authHeaders: (token?: string): Record<string, string> =>
    token ? { Authorization: `Bearer ${token}` } : {},
  doFetch: vi.fn<typeof TypeImport_1n561g5.doFetch>(),
  GatewayClientError: class GatewayClientError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
      this.name = "GatewayClientError";
    }
  },
}));

const gatewayAuth = {
  baseUrl: "https://gateway.test",
  token: "secret",
  vaultId: "vault-a",
};

describe(borrowedReplicaFetcher, () => {
  it("routes the ordinary session contract through one encoded edge", async () => {
    const delegate = vi
      .fn<ReplicaFetcher>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const fetcher = borrowedReplicaFetcher("edge/a", delegate);

    await fetcher(
      gatewayAuth.baseUrl,
      "/centraid/_vault/replica/bootstrap?window=5000",
      { method: "GET" }
    );
    await fetcher(
      gatewayAuth.baseUrl,
      "/centraid/_vault/changes?since=borrowed%3Aedge%2Fa%3A17&shapeIds=s",
      { method: "GET" }
    );
    await fetcher(gatewayAuth.baseUrl, "/centraid/_vault/replica/intents", {
      method: "POST",
    });

    expect(delegate.mock.calls.map((call) => call[1])).toStrictEqual([
      "/centraid/_vault/replica/borrowed/bootstrap?edgeId=edge%2Fa",
      "/centraid/_vault/replica/borrowed/changes?edgeId=edge%2Fa&since=17",
      "/centraid/_vault/replica/borrowed/intents?edgeId=edge%2Fa",
    ]);
  });

  it("keeps borrowed checkpoints local", async () => {
    const delegate = vi.fn<ReplicaFetcher>();
    const response = await borrowedReplicaFetcher("edge-1", delegate)(
      gatewayAuth.baseUrl,
      "/centraid/_vault/replica/checkpoint",
      { method: "POST" }
    );
    expect(response.status).toBe(200);
    expect(delegate).not.toHaveBeenCalled();
  });
});

describe(fetchReplicaChanges, () => {
  it("attests the sorted, deduplicated persisted shape ids on every pull", async () => {
    const fetcher = vi.fn<ReplicaFetcher>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            schemaEpoch: "1",
            from: { epoch: "epoch-a", seq: 4 },
            to: { epoch: "epoch-a", seq: 5 },
            changes: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    await fetchReplicaChanges(
      gatewayAuth,
      { epoch: "epoch-a", seq: 4 },
      new AbortController().signal,
      ["shape-z", "shape-a", "shape-z"],
      fetcher
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toBe(
      "/centraid/_vault/changes?since=epoch-a%3A4&shapeIds=shape-a%2Cshape-z"
    );

    await fetchReplicaChanges(
      gatewayAuth,
      { epoch: "epoch-a", seq: 5 },
      new AbortController().signal,
      [],
      fetcher
    );
    expect(fetcher.mock.calls[1]?.[1]).toBe(
      "/centraid/_vault/changes?since=epoch-a%3A5&shapeIds="
    );
  });

  it("turns a stale shape attestation conflict into a typed rebootstrap", async () => {
    const fetcher = vi.fn<ReplicaFetcher>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "replica_rebootstrap_required",
          reason: "shape-changed",
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      fetchReplicaChanges(
        gatewayAuth,
        { epoch: "epoch-a", seq: 4 },
        new AbortController().signal,
        ["shape-stale"],
        fetcher
      )
    ).rejects.toBeInstanceOf(ReplicaRebootstrapRequiredError);
  });
});

describe(fetchReplicaIntentOutcomes, () => {
  it("batches exact pending ids behind the bootstrap watermark", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `intent-${index}`);
    const through = { epoch: "epoch-a", seq: 42 };
    const fetcher = vi
      .fn<ReplicaFetcher>()
      .mockImplementation(async (_baseUrl, pathname, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          intentIds: string[];
          through: { epoch: string; seq: number };
        };
        expect(pathname).toBe("/centraid/_vault/replica/outcomes");
        expect(body.through).toStrictEqual(through);
        return new Response(
          JSON.stringify({
            outcomes: body.intentIds.map((intentId) => ({
              intentId,
              status: "executed",
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

    const outcomes = await fetchReplicaIntentOutcomes(
      gatewayAuth,
      [...ids, ids[0]!],
      through,
      fetcher
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(501);
    expect(outcomes.at(-1)).toStrictEqual({
      intentId: "intent-500",
      status: "executed",
    });
  });
});
