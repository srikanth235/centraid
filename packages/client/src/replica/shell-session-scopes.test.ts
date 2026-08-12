// Multi-scope replica sessions (issue #599).
//
// The regression these lock down is the one that made multi-scope unsafe:
// `doFetch` stamps `x-centraid-vault` from the shell's AMBIENT focused vault
// whenever the caller left it unset, so before this change EVERY replica
// session — whatever scope it was keyed by — bootstrapped against whichever
// vault happened to be focused, and wrote those rows into its own store. With
// one scope mounted that was invisible; with two it is silent cross-vault data
// corruption. Each session must stamp its OWN scope on every request.
import {
  describe,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";

import type { ShellReplicaCoordinator } from "./shell-session.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";
import type { ReplicaShape, ReplicaStatus } from "./types.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;
let fetchReplicaForScope: typeof TypeImport_1vwuba6.fetchReplicaForScope;

const FOCUSED_VAULT = "vault-focused";
const BASE_URL = "https://gateway.example";

const shapes: ReplicaShape[] = [
  {
    shapeId: "shape-media",
    appId: "photos",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "media.asset",
        primaryKey: "asset_id",
        columns: ["asset_id", "captured_at"],
      },
    ],
  },
];

function fakeCoordinator(): ShellReplicaCoordinator {
  return {
    bootstrap: vi
      .fn<ShellReplicaCoordinator["bootstrap"]>()
      .mockResolvedValue({ epoch: "e", seq: 1 }),
    status: vi
      .fn<ShellReplicaCoordinator["status"]>()
      .mockResolvedValue({ mode: "memory", cursor: null, schemaEpoch: null }),
    catalog: vi
      .fn<ShellReplicaCoordinator["catalog"]>()
      .mockResolvedValue(shapes),
    readWire: vi.fn<ShellReplicaCoordinator["readWire"]>().mockResolvedValue({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "shape-media", entity: "media.asset" },
    }),
    searchWire: vi
      .fn<ShellReplicaCoordinator["searchWire"]>()
      .mockResolvedValue({
        rows: [],
        cursor: { epoch: "e", seq: 1 },
        dependency: { shapeId: "shape-media", entity: "media.asset" },
      }),
    enqueue: vi.fn<ShellReplicaCoordinator["enqueue"]>(),
    claimNextIntent: vi
      .fn<ShellReplicaCoordinator["claimNextIntent"]>()
      .mockResolvedValue(undefined),
    markIntentTransportFailed:
      vi.fn<ShellReplicaCoordinator["markIntentTransportFailed"]>(),
    markIntentAwaitingChange:
      vi.fn<ShellReplicaCoordinator["markIntentAwaitingChange"]>(),
    applyIntentOutcome: vi.fn<ShellReplicaCoordinator["applyIntentOutcome"]>(),
    discardIntent: vi
      .fn<ShellReplicaCoordinator["discardIntent"]>()
      .mockResolvedValue(false),
    retryIntent: vi
      .fn<ShellReplicaCoordinator["retryIntent"]>()
      .mockResolvedValue(undefined),
    recoverSending: vi
      .fn<ShellReplicaCoordinator["recoverSending"]>()
      .mockResolvedValue([]),
    pendingIntents: vi
      .fn<ShellReplicaCoordinator["pendingIntents"]>()
      .mockResolvedValue([]),
    subscribeInvalidations: vi
      .fn<ShellReplicaCoordinator["subscribeInvalidations"]>()
      .mockReturnValue(() => undefined),
    close: vi
      .fn<ShellReplicaCoordinator["close"]>()
      .mockResolvedValue(undefined),
    purge: vi
      .fn<ShellReplicaCoordinator["purge"]>()
      .mockResolvedValue(undefined),
  };
}

const COLD: ReplicaStatus = { mode: "memory", cursor: null, schemaEpoch: null };

let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let priorFetch: typeof globalThis.fetch;

function bootstrapResponse(): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 1,
      vaultId: "whatever",
      schemaEpoch: "epoch-1",
      cursor: {
        epoch: "epoch-1",
        seq: 1,
      },
      rows: [],
      shapes,
      outcomes: [],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}
describe("shell-session-scopes suite", () => {
  beforeAll(async () => {
    Object.assign(window, {
      CentraidApi: {
        // The AMBIENT answer. Nothing below is mounted on this vault — anything
        // addressing it is the bug this suite exists for.
        getGatewayAuth: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            token: "token",
            gatewayId: "profile-home",
            vaultId: FOCUSED_VAULT,
            rememberDevice: false,
          }),
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({ ReplicaShellSession, fetchReplicaForScope } =
      await import("./shell-session.js"));
  });

  beforeEach(() => {
    priorFetch = globalThis.fetch;
    // A fresh Response per call: a body may only be read once, and both sessions
    // bootstrap through this same mock.
    fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => bootstrapResponse());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = priorFetch;
  });

  /** Every `x-centraid-vault` the transport actually put on the wire. */
  function stampedVaults(): string[] {
    return fetchMock.mock.calls.map(([, init]) => {
      const headers = new Headers((init as RequestInit).headers as HeadersInit);
      return headers.get("x-centraid-vault") ?? "<unstamped>";
    });
  }

  test("the scoped transport stamps its own scope, never the focused one", async () => {
    const fetcher = fetchReplicaForScope({
      baseUrl: BASE_URL,
      token: "token",
      gatewayId: "profile-home",
      vaultId: "vault-family",
    });
    await fetcher(BASE_URL, "/centraid/_vault/replica/bootstrap", {
      headers: {},
    });
    expect(stampedVaults()).toStrictEqual(["vault-family"]);
  });

  test("a stale ambient stamp is overwritten, not respected", async () => {
    const fetcher = fetchReplicaForScope({
      baseUrl: BASE_URL,
      token: "token",
      gatewayId: "profile-home",
      vaultId: "vault-family",
    });
    await fetcher(BASE_URL, "/centraid/_vault/replica/changes", {
      headers: { "x-centraid-vault": FOCUSED_VAULT },
    });
    expect(stampedVaults()).toStrictEqual(["vault-family"]);
  });

  test("two concurrently mounted sessions each address their own scope", async () => {
    const own = new ReplicaShellSession(
      {
        baseUrl: BASE_URL,
        token: "token",
        gatewayId: "profile-home",
        vaultId: "vault-own",
      },
      fakeCoordinator(),
      {
        isOnline: () => true,
        eventTarget: { addEventListener() {}, removeEventListener() {} },
      }
    );
    const family = new ReplicaShellSession(
      {
        baseUrl: BASE_URL,
        token: "token",
        gatewayId: "profile-home",
        vaultId: "vault-family",
      },
      fakeCoordinator(),
      {
        isOnline: () => true,
        eventTarget: { addEventListener() {}, removeEventListener() {} },
      }
    );
    await own.start(COLD);
    await family.start(COLD);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    );

    const stamped = stampedVaults();
    expect(stamped).toContain("vault-own");
    expect(stamped).toContain("vault-family");
    // The point of the suite: neither session ever spoke for the focused vault.
    expect(stamped).not.toContain(FOCUSED_VAULT);
    expect(stamped).not.toContain("<unstamped>");
    await own.close();
    await family.close();
  });
});
