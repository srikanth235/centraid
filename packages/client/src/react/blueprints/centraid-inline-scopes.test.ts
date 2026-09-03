import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InlineAppModule,
  InlineScope,
} from "@centraid/blueprints/apps/inline-types";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import {
  addInlineScope,
  createInlineCentraidClient,
  InlineScopeError,
} from "./centraid-inline.js";
import type {
  InlineScopeBinding,
  InlineScopeSession,
} from "./centraid-inline.js";

const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof TypeImport_oycips.doFetch>(),
  readJson: vi.fn<(res: Response, op: string) => Promise<unknown>>(),
}));
vi.mock(
  import("../../gateway-client-core.js") as Promise<unknown>,
  async () => ({
    auth: vi.fn<typeof TypeImport_oycips.auth>(async () => ({
      baseUrl: "https://gw.test",
      token: "tok",
    })),
    authHeaders: (token: string | undefined, ct?: string) => ({
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ct ? { "Content-Type": ct } : {}),
    }),
    VAULT_HEADER: "x-centraid-vault",
    doFetch,
    readJson: <T>(...args: Parameters<typeof readJson>) =>
      readJson(...args) as Promise<T>,
  })
);

interface Fake extends InlineScopeSession {
  writes: unknown[];
  emit: (invalidation: ReplicaInvalidation) => void;
}

function fakeSession(): Fake {
  const writes: unknown[] = [];
  const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> = [];
  return {
    writes,
    emit(invalidation: ReplicaInvalidation) {
      for (const listener of subscribers.slice()) listener([invalidation]);
    },
    read: vi.fn<InlineScopeSession["read"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "media.asset" },
    })),
    search: vi.fn<InlineScopeSession["search"]>(async () => ({
      rows: [],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "media.asset" },
    })),
    write: vi.fn<InlineScopeSession["write"]>(async (_appId, input) => {
      writes.push(input);
      return { intentId: "i-1", status: "executed" };
    }),
    subscribe: vi.fn<InlineScopeSession["subscribe"]>(
      (_appId, _deps, listener) => {
        subscribers.push(listener);
        return () => {
          const i = subscribers.indexOf(listener);
          if (i >= 0) subscribers.splice(i, 1);
        };
      }
    ),
  } as unknown as Fake;
}

function scope(id: string, label: string, canWrite: boolean): InlineScope {
  return { id, label, canWrite };
}

/** A query module that just reports which session it ran against. */
function tellScope(name: string): InlineAppModule["queries"] {
  return {
    [name]: {
      default: ({ ctx }: { ctx: unknown }) =>
        (ctx as { vault: { read: (r: unknown) => Promise<unknown> } }).vault
          .read({ entity: "media.asset" })
          .then(() => ({ ok: true })),
    },
  } as unknown as InlineAppModule["queries"];
}

const own = scope("vault-own", "Library", true);
const family = scope("vault-family", "Family", true);
const readOnly = scope("vault-grandma", "Grandma", false);

function build(bindings: InlineScopeBinding[]) {
  return createInlineCentraidClient({
    appId: "photos",
    queries: tellScope("library"),
    scopes: bindings,
  });
}

describe("multi-scope inline client", () => {
  beforeEach(() => {
    doFetch.mockReset();
    readJson.mockReset();
  });

  it("exposes its scopes, primary first", () => {
    const client = build([
      { scope: own, session: fakeSession() },
      { scope: family, session: fakeSession() },
    ]);
    expect(client.scopes.map((s) => s.id)).toStrictEqual([
      "vault-own",
      "vault-family",
    ]);
  });

  it("read addresses the primary scope, and a named scope when asked", async () => {
    const ownSession = fakeSession();
    const familySession = fakeSession();
    const client = build([
      { scope: own, session: ownSession },
      { scope: family, session: familySession },
    ]);
    await client.read({ query: "library" });
    expect(ownSession.read).toHaveBeenCalledOnce();
    expect(familySession.read).not.toHaveBeenCalled();

    await client.read({ query: "library", scope: "vault-family" });
    expect(familySession.read).toHaveBeenCalledOnce();
  });

  it("refuses a scope that is not mounted rather than falling back", async () => {
    const client = build([{ scope: own, session: fakeSession() }]);
    await expect(
      client.read({ query: "library", scope: "vault-nope" })
    ).rejects.toMatchObject({
      code: "UNKNOWN_SCOPE",
    });
  });

  it("readAll fans out and reports a failing scope as data, not a rejection", async () => {
    const ownSession = fakeSession();
    const brokenSession = fakeSession();
    (brokenSession.read as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("audience is unreachable"), {
        code: "VAULT_ERROR",
      })
    );
    const client = build([
      { scope: own, session: ownSession },
      { scope: family, session: brokenSession },
    ]);
    const results = await client.readAll({ query: "library" });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ scope: "vault-own", ok: true });
    expect(results[1]).toMatchObject({
      scope: "vault-family",
      ok: false,
      error: { code: "VAULT_ERROR" },
    });
  });

  it('readAll can be restricted — "load more" only re-queries the horizon scopes', async () => {
    const ownSession = fakeSession();
    const familySession = fakeSession();
    const client = build([
      { scope: own, session: ownSession },
      { scope: family, session: familySession },
    ]);
    const results = await client.readAll({
      query: "library",
      scopes: ["vault-family"],
    });
    expect(results.map((r) => r.scope)).toStrictEqual(["vault-family"]);
    expect(ownSession.read).not.toHaveBeenCalled();
  });

  it("write reaches the named scope", async () => {
    const ownSession = fakeSession();
    const familySession = fakeSession();
    const client = build([
      { scope: own, session: ownSession },
      { scope: family, session: familySession },
    ]);
    await client.write({
      action: "upload",
      input: { a: 1 },
      scope: "vault-family",
    });
    expect(familySession.writes).toHaveLength(1);
    expect(ownSession.writes).toHaveLength(0);
  });

  it("write refuses a read-only scope with a typed code, before any intent", async () => {
    const grandmaSession = fakeSession();
    const client = build([
      { scope: own, session: fakeSession() },
      { scope: readOnly, session: grandmaSession },
    ]);
    const refusal = client.write({ action: "upload", scope: "vault-grandma" });
    await expect(refusal).rejects.toBeInstanceOf(InlineScopeError);
    await expect(refusal).rejects.toMatchObject({ code: "SCOPE_READONLY" });
    // The point of refusing client-side: no intent was ever enqueued.
    expect(grandmaSession.writes).toHaveLength(0);
  });

  it("onChange fans in, tagging every event with the scope it came from", () => {
    const ownSession = fakeSession();
    const familySession = fakeSession();
    const client = build([
      { scope: own, session: ownSession },
      { scope: family, session: familySession },
    ]);
    const seen: Array<string | undefined> = [];
    const stop = client.onChange((detail) => seen.push(detail.scope));
    familySession.emit({
      shapeId: "s",
      entity: "media.asset",
      source: "canonical",
    });
    ownSession.emit({
      shapeId: "s",
      entity: "media.asset",
      source: "canonical",
    });
    expect(seen).toStrictEqual(["vault-family", "vault-own"]);
    stop();
    familySession.emit({
      shapeId: "s",
      entity: "media.asset",
      source: "canonical",
    });
    expect(seen).toHaveLength(2);
  });

  it("a scope hydrated after first paint joins existing listeners and announces itself", () => {
    const ownSession = fakeSession();
    const client = build([{ scope: own, session: ownSession }]);
    const seen: Array<{ scope?: string; source?: string }> = [];
    client.onChange((detail) => seen.push(detail));

    const familySession = fakeSession();
    expect(
      addInlineScope(client, { scope: family, session: familySession })
    ).toBe(true);
    // The arrival is announced on the change channel, tagged with the NEW scope,
    // so the app refetches exactly that one instead of re-reading everything.
    expect(seen).toStrictEqual([
      expect.objectContaining({ source: "scope-added", scope: "vault-family" }),
    ]);
    expect(client.scopes.map((s) => s.id)).toStrictEqual([
      "vault-own",
      "vault-family",
    ]);

    familySession.emit({
      shapeId: "s",
      entity: "media.asset",
      source: "canonical",
    });
    expect(seen.at(-1)).toMatchObject({
      scope: "vault-family",
      source: "canonical",
    });
  });

  it("addInlineScope ignores an object it did not build", () => {
    expect(addInlineScope({}, { scope: family, session: fakeSession() })).toBe(
      false
    );
  });

  it("the online-read fallback names the scope so the gateway cannot answer for another", async () => {
    const offline = fakeSession();
    (offline.read as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("needs the online vault"), {
        code: "ONLINE_ONLY",
      })
    );
    doFetch.mockResolvedValue(new Response());
    readJson.mockResolvedValue({ ok: true });
    const client = build([
      { scope: own, session: fakeSession() },
      { scope: family, session: offline },
    ]);
    await client.read({ query: "library", scope: "vault-family" });
    const call = doFetch.mock.calls[0] as [string, string, RequestInit];
    const init = call[2];
    expect((init.headers as Record<string, string>)["x-centraid-vault"]).toBe(
      "vault-family"
    );
  });
});
