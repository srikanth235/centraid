import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  PrefsStore,
  makeUserStoreRouteHandler,
  resolveSubsystemConfigPins,
  resolveSubsystemModel,
  resolveSubsystemHarness,
  resolveSubsystemHarnessLadder,
} from "./prefs-store.js";

function freshFile(): string {
  return path.join(tempDirSync("centraid-prefs-"), "prefs.json");
}

/** A minimal async-iterable IncomingMessage carrying an optional JSON body. */
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as unknown as IncomingMessage & {
    url: string;
    method: string;
  };
  req.url = url;
  req.method = method;
  return req;
}

interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  json: unknown;
}
function mockRes(): { res: ServerResponse; out: CapturedRes } {
  const out: CapturedRes = { statusCode: 0, headers: {}, json: undefined };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.statusCode = status;
      out.headers = headers;
      return this;
    },
    end(text?: string) {
      out.json = text ? JSON.parse(text) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe(PrefsStore, () => {
  it("starts empty on a missing file", () => {
    expect(new PrefsStore(freshFile()).getAllPrefs()).toStrictEqual({});
  });

  it("starts empty when the file holds a non-object (defensive)", () => {
    const f = freshFile();
    writeFileSync(f, JSON.stringify(["not", "an", "object"]));
    expect(new PrefsStore(f).getAllPrefs()).toStrictEqual({});
  });

  it("starts empty when the file is unreadable JSON", () => {
    const f = freshFile();
    writeFileSync(f, "{ not json");
    expect(new PrefsStore(f).getAllPrefs()).toStrictEqual({});
  });

  it("merges a patch and persists atomically (survives a reload)", () => {
    const f = freshFile();
    const store = new PrefsStore(f);
    const after = store.setPrefs({ harness: "codex", theme: "night" });
    expect(after).toStrictEqual({ harness: "codex", theme: "night" });
    // A fresh instance reads the same bytes off disk (tmp + rename landed).
    expect(new PrefsStore(f).getAllPrefs()).toStrictEqual({
      harness: "codex",
      theme: "night",
    });
    // getAllPrefs returns a defensive copy, not the live cache.
    const copy = store.getAllPrefs();
    copy.harness = "mutated";
    expect(store.getAllPrefs().harness).toBe("codex");
  });

  it("treats null / undefined values as key deletions", () => {
    const f = freshFile();
    const store = new PrefsStore(f);
    store.setPrefs({ a: 1, b: 2, c: 3 });
    const after = store.setPrefs({ a: null, b: undefined });
    expect(after).toStrictEqual({ c: 3 });
    expect(JSON.parse(readFileSync(f, "utf8"))).toStrictEqual({ c: 3 });
  });

  it("an empty patch is a no-op that still returns the current prefs", () => {
    const store = new PrefsStore(freshFile());
    store.setPrefs({ x: 1 });
    expect(store.setPrefs({})).toStrictEqual({ x: 1 });
  });
});

describe(resolveSubsystemModel, () => {
  it("prefers the explicit override over any pref", () => {
    const prefs = {
      "model.claude-code.assistant": "from-subsystem-pref",
      "model.claude-code.default": "from-default-pref",
    };
    expect(
      resolveSubsystemModel(prefs, "claude-code", "assistant", "explicit-model")
    ).toBe("explicit-model");
  });

  it("falls through to the per-subsystem pref when there is no explicit value", () => {
    const prefs = {
      "model.claude-code.assistant": "from-subsystem-pref",
      "model.claude-code.default": "from-default-pref",
    };
    expect(resolveSubsystemModel(prefs, "claude-code", "assistant")).toBe(
      "from-subsystem-pref"
    );
  });

  it("falls through to the harness-wide default when the subsystem pref is unset", () => {
    const prefs = { "model.claude-code.default": "from-default-pref" };
    expect(resolveSubsystemModel(prefs, "claude-code", "assistant")).toBe(
      "from-default-pref"
    );
  });

  it("treats an empty-string pref as unset and keeps falling through", () => {
    const prefs = {
      "model.claude-code.assistant": "",
      "model.claude-code.default": "from-default-pref",
    };
    expect(resolveSubsystemModel(prefs, "claude-code", "assistant")).toBe(
      "from-default-pref"
    );
  });

  it("resolves to undefined when nothing is configured — the harness uses its own default", () => {
    expect(
      resolveSubsystemModel({}, "claude-code", "assistant")
    ).toBeUndefined();
  });

  it("scopes prefs by harness kind — a codex pref does not leak into claude-code resolution", () => {
    const prefs = { "model.codex.assistant": "codex-only-model" };
    expect(
      resolveSubsystemModel(prefs, "claude-code", "assistant")
    ).toBeUndefined();
  });

  it("scopes prefs by subsystem — an ask override does not leak into builder resolution", () => {
    const prefs = { "model.codex.ask": "ask-only-model" };
    expect(resolveSubsystemModel(prefs, "codex", "builder")).toBeUndefined();
  });

  it("ignores an empty-string explicit override (falls through like unset)", () => {
    const prefs = { "model.codex.automations": "automations-model" };
    expect(resolveSubsystemModel(prefs, "codex", "automations", "")).toBe(
      "automations-model"
    );
  });
});

describe(resolveSubsystemConfigPins, () => {
  const prefs = {
    "config.claude-code.default.thought_level": "medium",
    "config.claude-code.assistant.thought_level": "high",
    "config.claude-code.default.mode": "plan",
    "config.codex.assistant.thought_level": "low",
  };

  it("uses explicit category pins before subsystem and harness defaults", () => {
    expect(
      resolveSubsystemConfigPins(prefs, "claude-code", "assistant", {
        thought_level: "max",
      })
    ).toStrictEqual({ thought_level: "max", mode: "plan" });
  });

  it("keeps categories scoped to the selected harness and subsystem", () => {
    expect(
      resolveSubsystemConfigPins(prefs, "claude-code", "assistant")
    ).toStrictEqual({
      thought_level: "high",
      mode: "plan",
    });
    expect(
      resolveSubsystemConfigPins(prefs, "claude-code", "builder")
    ).toStrictEqual({
      thought_level: "medium",
      mode: "plan",
    });
    expect(
      resolveSubsystemConfigPins(prefs, "codex", "assistant")
    ).toStrictEqual({
      thought_level: "low",
    });
  });
});

describe(resolveSubsystemHarness, () => {
  it("prefers the per-subsystem pin over the default harness", () => {
    const prefs = {
      "harness.assistant": "claude-code",
      "harness.kind": "codex",
    };
    expect(resolveSubsystemHarness(prefs, "assistant")).toBe("claude-code");
  });

  it("falls back to the default harness when the subsystem is unpinned", () => {
    const prefs = { "harness.kind": "claude-code" };
    expect(resolveSubsystemHarness(prefs, "assistant")).toBe("claude-code");
  });

  it("falls back to 'codex' when nothing is configured at all", () => {
    expect(resolveSubsystemHarness({}, "assistant")).toBe("codex");
  });

  it("scopes pins by subsystem — an ask pin does not leak into builder resolution", () => {
    const prefs = { "harness.ask": "claude-code", "harness.kind": "codex" };
    expect(resolveSubsystemHarness(prefs, "ask")).toBe("claude-code");
    // Every other subsystem still inherits the default harness.
    expect(resolveSubsystemHarness(prefs, "builder")).toBe("codex");
    expect(resolveSubsystemHarness(prefs, "assistant")).toBe("codex");
    expect(resolveSubsystemHarness(prefs, "automations")).toBe("codex");
  });

  it("treats an empty-string pin as unset and keeps falling through", () => {
    const prefs = { "harness.builder": "", "harness.kind": "claude-code" };
    expect(resolveSubsystemHarness(prefs, "builder")).toBe("claude-code");
    // ...all the way to the built-in default when there's no default harness either.
    expect(resolveSubsystemHarness({ "harness.builder": "" }, "builder")).toBe(
      "codex"
    );
  });

  it("treats an empty-string default harness as unset (falls through to codex)", () => {
    expect(resolveSubsystemHarness({ "harness.kind": "" }, "automations")).toBe(
      "codex"
    );
  });

  it("each subsystem can pin a different harness independently", () => {
    const prefs = {
      "harness.assistant": "claude-code",
      "harness.automations": "codex",
      "harness.kind": "claude-code",
    };
    expect(resolveSubsystemHarness(prefs, "assistant")).toBe("claude-code");
    expect(resolveSubsystemHarness(prefs, "automations")).toBe("codex");
    // Unpinned subsystems still inherit the default harness.
    expect(resolveSubsystemHarness(prefs, "ask")).toBe("claude-code");
  });

  it("is byte-identical to the old global behavior when no harness.* key is set", () => {
    // Back-compat is the hard requirement: with only `harness.kind`
    // present, EVERY subsystem resolves to it — exactly what the single
    // global active harness did before per-subsystem selection existed.
    for (const kind of ["codex", "claude-code"] as const) {
      const prefs = { "harness.kind": kind };
      for (const s of ["assistant", "ask", "builder", "automations"] as const) {
        expect(resolveSubsystemHarness(prefs, s)).toBe(kind);
      }
    }
  });
});

/**
 * The two resolvers compose the way the gateway's `resolveModel` uses them:
 * resolve the HARNESS for the subsystem first, then scope the model key by
 * THAT kind. Reading the model against the global kind instead is the bug
 * this pairing exists to prevent.
 */
describe("resolveSubsystemHarness + resolveSubsystemModel compose", () => {
  it("reads the model key of the subsystem's OWN harness, not the default harness's", () => {
    const prefs = {
      "harness.kind": "codex",
      "harness.ask": "claude-code",
      "model.codex.ask": "codex-ask-model",
      "model.claude-code.ask": "claude-ask-model",
    };
    const kind = resolveSubsystemHarness(prefs, "ask");
    expect(kind).toBe("claude-code");
    expect(resolveSubsystemModel(prefs, kind, "ask")).toBe("claude-ask-model");
    // The builder, still unpinned, keeps reading the default harness's keys.
    expect(
      resolveSubsystemModel(
        prefs,
        resolveSubsystemHarness(prefs, "builder"),
        "ask"
      )
    ).toBe("codex-ask-model");
  });
});

describe(resolveSubsystemHarnessLadder, () => {
  it("keeps the primary first and removes unknown and duplicate kinds", () => {
    expect(
      resolveSubsystemHarnessLadder(
        {
          "harness.ladder.assistant": [
            "claude-code",
            "codex",
            "bogus",
            "claude-code",
          ],
        },
        "assistant",
        "codex"
      )
    ).toStrictEqual(["codex", "claude-code"]);
  });

  it("accepts the CLI-friendly JSON representation and default ladder", () => {
    expect(
      resolveSubsystemHarnessLadder(
        { "harness.ladder.default": '["gemini","claude-code"]' },
        "builder",
        "codex"
      )
    ).toStrictEqual(["codex", "gemini", "claude-code"]);
  });
});

describe(makeUserStoreRouteHandler, () => {
  const handlerFor = (ownerId?: () => string) => {
    const store = new PrefsStore(freshFile());
    return { handler: makeUserStoreRouteHandler(() => store, ownerId), store };
  };

  it("ignores routes outside the /_centraid-user prefix", async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await expect(handler(mockReq("GET", "/centraid/other"), res)).resolves.toBe(
      false
    );
    expect(out.statusCode).toBe(0);
  });

  it("GET /id returns the owner id when a provider is wired", async () => {
    const { handler } = handlerFor(() => "party-42");
    const { res, out } = mockRes();
    await expect(
      handler(mockReq("GET", "/_centraid-user/id"), res)
    ).resolves.toBe(true);
    expect(out.statusCode).toBe(200);
    expect(out.json).toStrictEqual({ id: "party-42" });
  });

  it("GET /id 404s when no vault/owner provider is wired", async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq("GET", "/_centraid-user/id"), res);
    expect(out.statusCode).toBe(404);
  });

  it("rejects a non-GET on /id", async () => {
    const { handler } = handlerFor(() => "x");
    const { res, out } = mockRes();
    await handler(mockReq("POST", "/_centraid-user/id"), res);
    expect(out.statusCode).toBe(405);
  });

  it("GET then PUT /prefs round-trips a patch", async () => {
    const { handler } = handlerFor();
    let cap = mockRes();
    await handler(mockReq("GET", "/_centraid-user/prefs"), cap.res);
    expect(cap.out.json).toStrictEqual({ prefs: {} });

    cap = mockRes();
    await handler(
      mockReq("PUT", "/_centraid-user/prefs", { patch: { theme: "paper" } }),
      cap.res
    );
    expect(cap.out.statusCode).toBe(200);
    expect(cap.out.json).toStrictEqual({ prefs: { theme: "paper" } });
  });

  it("rejects a preflight-failed patch without changing prefs", async () => {
    const store = new PrefsStore(freshFile());
    store.setPrefs({ "harness.kind": "codex" });
    const handler = makeUserStoreRouteHandler(() => store, undefined, {
      validatePatch: async () => "agent is unavailable",
    });
    const { res, out } = mockRes();
    await handler(
      mockReq("PUT", "/_centraid-user/prefs", {
        patch: { "harness.kind": "claude-code" },
      }),
      res
    );
    expect(out.statusCode).toBe(409);
    expect(store.getAllPrefs()["harness.kind"]).toBe("codex");
  });

  it("runs post-commit hooks with before and after snapshots", async () => {
    const store = new PrefsStore(freshFile());
    store.setPrefs({ a: 1 });
    let observed: unknown;
    const handler = makeUserStoreRouteHandler(() => store, undefined, {
      afterPatch: (patch, before, after) => {
        observed = { patch, before, after };
      },
    });
    const { res } = mockRes();
    await handler(
      mockReq("PUT", "/_centraid-user/prefs", { patch: { a: 2 } }),
      res
    );
    expect(observed).toStrictEqual({
      patch: { a: 2 },
      before: { a: 1 },
      after: { a: 2 },
    });
  });

  it("PUT /prefs 400s without a patch object", async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq("PUT", "/_centraid-user/prefs", { nope: true }), res);
    expect(out.statusCode).toBe(400);
  });

  it("rejects an unsupported method on /prefs", async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq("DELETE", "/_centraid-user/prefs"), res);
    expect(out.statusCode).toBe(405);
  });

  it("404s an unknown sub-route under the prefix", async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq("GET", "/_centraid-user/bogus"), res);
    expect(out.statusCode).toBe(404);
  });
});
