import { assert, describe, expect, it } from "vitest";

import { parseRoute, parseWithDraft } from "./router.js";

describe("parseRoute — app RPC routes (issue #505)", () => {
  it("parses POST /centraid/<id>/actions/<action>", () => {
    const r = parseRoute("POST", "/centraid/todos/actions/add");
    expect(r.kind).toBe("app-action");
    // Narrows the route union so the per-kind assertions below always run.
    assert(r.kind === "app-action");
    expect(r.appId).toBe("todos");
    expect(r.action).toBe("add");
  });

  it("parses POST /centraid/<id>/queries/<query>", () => {
    const r = parseRoute("POST", "/centraid/todos/queries/upcoming");
    expect(r.kind).toBe("app-query");
    assert(r.kind === "app-query");
    expect(r.appId).toBe("todos");
    expect(r.query).toBe("upcoming");
  });

  it("decodes percent-encoded handler names", () => {
    const r = parseRoute("POST", "/centraid/todos/actions/add%2Ditem");
    expect(r.kind).toBe("app-action");
    assert(r.kind === "app-action");
    expect(r.action).toBe("add-item");
  });

  it("parses GET /centraid/<id>/_describe with an optional filter", () => {
    const bare = parseRoute("GET", "/centraid/todos/_describe");
    expect(bare.kind).toBe("app-describe");
    assert(bare.kind === "app-describe");
    expect(bare.query).toStrictEqual({});
    const filtered = parseRoute("GET", "/centraid/todos/_describe?action=add");
    expect(filtered.kind).toBe("app-describe");
    assert(filtered.kind === "app-describe");
    expect(filtered.query).toStrictEqual({ action: "add" });
  });

  it("rejects non-POST action/query invocation", () => {
    // No UI-byte serving (#799): a GET does not fall through to a static
    // read — the RPC plane is POST-only and everything else 404s.
    expect(parseRoute("GET", "/centraid/todos/queries/upcoming").kind).toBe(
      "not-found"
    );
    expect(parseRoute("PUT", "/centraid/todos/actions/add").kind).toBe(
      "not-found"
    );
  });

  it("rejects a bare or over-deep action/query path", () => {
    expect(parseRoute("POST", "/centraid/todos/actions").kind).toBe(
      "not-found"
    );
    expect(parseRoute("POST", "/centraid/todos/actions/add/extra").kind).toBe(
      "not-found"
    );
  });

  it("rejects non-GET /_describe", () => {
    expect(parseRoute("POST", "/centraid/todos/_describe").kind).toBe(
      "not-found"
    );
  });
});

describe("parseRoute — old per-app routes are gone (issue #107)", () => {
  it("GET /centraid/<id>/_data/<name> no longer dispatches", () => {
    const r = parseRoute("GET", "/centraid/todos/_data/list");
    expect(r.kind).not.toBe("app-data" as never);
    expect(r.kind).toBe("not-found");
  });

  it("POST /centraid/<id>/_run no longer dispatches", () => {
    const r = parseRoute("POST", "/centraid/todos/_run");
    expect(r.kind).not.toBe("app-run" as never);
    expect(r.kind).toBe("not-found");
  });
});

describe("parseRoute — UI-byte routes are gone (issue #799)", () => {
  it("the app index is no longer a route", () => {
    expect(parseRoute("GET", "/centraid/todos").kind).toBe("not-found");
    expect(parseRoute("GET", "/centraid/todos/").kind).toBe("not-found");
  });

  it("an app-relative file path is no longer a route", () => {
    expect(parseRoute("GET", "/centraid/todos/app.css").kind).toBe("not-found");
    expect(parseRoute("GET", "/centraid/todos/kit.ts").kind).toBe("not-found");
    expect(parseRoute("GET", "/centraid/todos/nested/thing.js").kind).toBe(
      "not-found"
    );
  });

  it("the browser query-bundle module is no longer a route", () => {
    expect(parseRoute("GET", "/centraid/todos/_query/upcoming.mjs").kind).toBe(
      "not-found"
    );
  });
});

describe("parseRoute — unaffected routes still work", () => {
  it("parses /_changes", () => {
    const r = parseRoute("GET", "/centraid/todos/_changes");
    expect(r.kind).toBe("app-changes");
  });

  it("parses /_turn", () => {
    const r = parseRoute("POST", "/centraid/todos/_turn");
    expect(r.kind).toBe("app-chat");
  });
});

describe("parseWithDraft — draft-preview prefix (issue #141)", () => {
  it("passes a non-draft URL through unchanged with no session id", () => {
    const { route, draftSessionId } = parseWithDraft(
      "POST",
      "/centraid/todos/queries/upcoming"
    );
    expect(draftSessionId).toBeUndefined();
    expect(route.kind).toBe("app-query");
  });

  it("peels the draft prefix off an app action invocation", () => {
    const { route, draftSessionId } = parseWithDraft(
      "POST",
      "/centraid/_draft/s1/todos/actions/add"
    );
    expect(draftSessionId).toBe("s1");
    expect(route.kind).toBe("app-action");
    expect((route as { appId: string }).appId).toBe("todos");
    expect((route as { action: string }).action).toBe("add");
  });

  it("peels the draft prefix off a _describe request", () => {
    const { route, draftSessionId } = parseWithDraft(
      "GET",
      "/centraid/_draft/s1/todos/_describe"
    );
    expect(draftSessionId).toBe("s1");
    expect(route.kind).toBe("app-describe");
    expect((route as { appId: string }).appId).toBe("todos");
  });

  it("peels the draft prefix off an app query invocation and preserves the inner shape", () => {
    const { route, draftSessionId } = parseWithDraft(
      "POST",
      "/centraid/_draft/s1/todos/queries/upcoming"
    );
    expect(draftSessionId).toBe("s1");
    expect(route.kind).toBe("app-query");
    expect((route as { appId: string }).appId).toBe("todos");
    expect((route as { query: string }).query).toBe("upcoming");
  });

  it("preserves the query string when rewriting", () => {
    const { route } = parseWithDraft(
      "GET",
      "/centraid/_draft/s1/todos/_describe?action=add"
    );
    expect(route.kind).toBe("app-describe");
    expect((route as { query: Record<string, string> }).query).toStrictEqual({
      action: "add",
    });
  });

  it("a draft prefix with no session id is not-found", () => {
    const { route } = parseWithDraft("GET", "/centraid/_draft/");
    expect(route.kind).toBe("not-found");
  });
});
