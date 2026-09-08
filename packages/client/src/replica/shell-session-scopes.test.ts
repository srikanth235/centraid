// Multi-scope replica sessions (#599).
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

import { MemoryIntentStore } from "./memory-intent-store.js";
import type * as TypeImport_identity from "./replica-identity.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";

let ReplicaShellSession: typeof TypeImport_1vwuba6.ReplicaShellSession;
let fetchReplicaForScope: typeof TypeImport_identity.fetchReplicaForScope;

const FOCUSED_VAULT = "vault-focused";
const BASE_URL = "https://gateway.example";

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
    ({ ReplicaShellSession } = await import("./shell-session.js"));
    ({ fetchReplicaForScope } = await import("./replica-identity.js"));
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
    // Each session gets its own outbox, and the wire calls under test are the
    // INTENT posts: a write is the one thing both sessions do that must carry
    // the scope it belongs to.
    const scoped = (vaultId: string): TypeImport_1vwuba6.ReplicaShellSession =>
      new ReplicaShellSession(
        {
          baseUrl: BASE_URL,
          token: "token",
          gatewayId: "profile-home",
          vaultId,
        },
        {
          intentStore: new MemoryIntentStore(),
          isOnline: () => true,
          eventTarget: { addEventListener() {}, removeEventListener() {} },
        }
      );
    const own = scoped("vault-own");
    const family = scoped("vault-family");
    await own.start();
    await family.start();
    await Promise.all([
      own.write("todos", { action: "rename", input: { title: "Own" } }),
      family.write("todos", { action: "rename", input: { title: "Family" } }),
    ]);
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
