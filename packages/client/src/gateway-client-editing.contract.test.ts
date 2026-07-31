// Client↔gateway seam laws for app editing + lifecycle (#141 Phase 2/4, #434,
// #599) — the module had no test file (#656 Layer 1B). Three laws carry the
// design: exactly ONE `desktop-<appId>` draft session per app, shared by every
// concurrent caller (the builder agent edits the same worktree, so a re-open
// 409 is success); a BUNDLED app installs rather than copies, so renaming it
// must never open a draft worktree; and a rejected delete must leave the draft
// session intact. Shared harness in gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  editing,
  installSeamContractHarness,
  json,
  requests,
  respond,
  sent,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("draft session seam", () => {
  it("law: the session id is derived from the app id, not minted per caller", async () => {
    await expect(editing.ensureAppSession("daily")).resolves.toBe(
      "desktop-daily"
    );
    expect(sentJson("POST /centraid/_apps/_sessions")).toStrictEqual({
      sessionId: "desktop-daily",
    });
  });

  it("law: concurrent callers share ONE open — the worktree is never opened twice", async () => {
    const [first, second] = await Promise.all([
      editing.ensureAppSession("daily"),
      editing.ensureAppSession("daily"),
    ]);

    expect([first, second]).toStrictEqual(["desktop-daily", "desktop-daily"]);
    expect(wireLog()).toStrictEqual(["POST /centraid/_apps/_sessions"]);
  });

  it("law: a re-open conflict is success — the draft worktree already exists", async () => {
    respond(
      "POST /centraid/_apps/_sessions",
      () => new Response("session exists", { status: 409 })
    );

    await expect(editing.ensureAppSession("daily")).resolves.toBe(
      "desktop-daily"
    );
  });

  it("law: a failed open is evicted so the next call retries instead of caching a wound", async () => {
    respond(
      "POST /centraid/_apps/_sessions",
      () => new Response("boom", { status: 500 })
    );
    await expect(editing.ensureAppSession("daily")).rejects.toMatchObject({
      code: "gateway_error",
    });

    respond("POST /centraid/_apps/_sessions", () =>
      json({ sessionId: "desktop-daily" })
    );
    await expect(editing.ensureAppSession("daily")).resolves.toBe(
      "desktop-daily"
    );
    expect(wireLog()).toStrictEqual([
      "POST /centraid/_apps/_sessions",
      "POST /centraid/_apps/_sessions",
    ]);
  });

  it("law: dropping a session closes the worktree and forgets it", async () => {
    await editing.ensureAppSession("daily");
    await editing.dropAppSession("daily");

    expect(wireLog()).toStrictEqual([
      "POST /centraid/_apps/_sessions",
      "DELETE /centraid/_apps/_sessions/desktop-daily",
    ]);
  });

  it("law: dropping a session that never opened closes nothing", async () => {
    respond(
      "POST /centraid/_apps/_sessions",
      () => new Response("boom", { status: 500 })
    );
    await editing.ensureAppSession("daily").catch(() => undefined);
    await editing.dropAppSession("daily");

    expect(wireLog()).toStrictEqual(["POST /centraid/_apps/_sessions"]);
  });
});

describe("draft preview seam", () => {
  it("law: the preview URL is cache-busted per resolve so the iframe re-navigates", async () => {
    const first = await editing.draftPreviewUrl("daily");
    const second = await editing.draftPreviewUrl("daily");

    expect(first.available).toBe(true);
    expect(first.url).toMatch(
      /^https:\/\/gateway\.test\/centraid\/_draft\/desktop-daily\/daily\/\?t=\d+$/u
    );
    expect(second.url.startsWith(first.url.split("?t=")[0] ?? "")).toBe(true);
  });

  it("law: a draft with no page yet reports unavailable instead of failing", async () => {
    respond(
      "GET /centraid/_draft/desktop-daily/daily/",
      () => new Response("", { status: 404 })
    );

    await expect(editing.draftPreviewUrl("daily")).resolves.toMatchObject({
      available: false,
    });
  });

  it("law: an unreachable gateway leaves the builder with an unavailable draft, not a crash", async () => {
    respond("GET /centraid/_draft/desktop-daily/daily/", () => {
      throw new Error("socket closed");
    });

    await expect(editing.draftPreviewUrl("daily")).resolves.toMatchObject({
      available: false,
    });
  });
});

describe("draft file seam", () => {
  it("law: every draft file op names the session it edits", async () => {
    await expect(editing.readAppFiles({ id: "daily" })).resolves.toStrictEqual([
      { path: "app.json", content: "{}" },
    ]);
    await editing.writeAppFile({
      id: "daily",
      path: "app.json",
      content: "{}",
    });

    expect(sent("GET /centraid/_apps/daily/files").query.get("sessionId")).toBe(
      "desktop-daily"
    );
    expect(
      sent("PUT /centraid/_apps/daily/files/app.json").query.get("sessionId")
    ).toBe("desktop-daily");
  });

  it("law: a file write ships as plain text, never as JSON", async () => {
    await editing.writeAppFile({
      id: "daily",
      path: "app.json",
      content: "{}",
    });

    expect(
      sent("PUT /centraid/_apps/daily/files/app.json").headers.get(
        "content-type"
      )
    ).toBe("text/plain; charset=utf-8");
  });

  it("law: an absent files array reads as an empty draft", async () => {
    respond("GET /centraid/_apps/daily/files", () => json({}));

    await expect(editing.readAppFiles({ id: "daily" })).resolves.toStrictEqual(
      []
    );
  });

  it("law: publish merges the named draft session and shapes the git result", async () => {
    await expect(editing.publish({ id: "daily" })).resolves.toStrictEqual({
      id: "daily",
      versionId: "v3",
      sha256: "deadbeef",
      activated: true,
      files: 0,
      bytes: 0,
      migrationsApplied: [],
    });
    expect(sentJson("POST /centraid/_apps/daily/publish")).toStrictEqual({
      sessionId: "desktop-daily",
      message: "publish daily",
    });
  });

  it("law: resetting draft data replays into the same session", async () => {
    await expect(editing.resetAppData({ id: "daily" })).resolves.toStrictEqual({
      id: "daily",
      seeded: true,
      migrationsApplied: [],
    });
    expect(sentJson("POST /centraid/_apps/daily/reset-data")).toStrictEqual({
      sessionId: "desktop-daily",
    });
  });
});

describe("app lifecycle seam", () => {
  it("law: creating an app names its target space and publishes a baseline", async () => {
    await expect(
      editing.createApp({ id: "daily", name: "Daily", scopeId: "vault-shared" })
    ).resolves.toStrictEqual({ id: "daily", name: "Daily" });

    const request = sent("POST /centraid/_apps");
    expect(request.headers.get("x-centraid-vault")).toBe("vault-shared");
    expect(JSON.parse(String(request.body))).toStrictEqual({
      id: "daily",
      name: "Daily",
      sessionId: "desktop-daily",
      publish: true,
    });
  });

  it("law: an unscoped creation falls back to the shell's ambient space", async () => {
    await editing.createApp({ id: "daily" });

    expect(sent("POST /centraid/_apps").headers.get("x-centraid-vault")).toBe(
      "vault-1"
    );
  });

  it("law: a clone forks code and reports its minted webhooks, empty when none", async () => {
    await expect(
      editing.cloneTemplate({ templateId: "daily" })
    ).resolves.toMatchObject({ app: { id: "daily-1" }, webhooks: [] });
    expect(sentJson("POST /centraid/_apps/_clone")).toStrictEqual({
      templateId: "daily",
      publish: true,
    });
  });

  it("law: installing a bundled app is consent, not a copy, and is idempotent", async () => {
    await expect(
      editing.installTemplate({ templateId: "tally", scopeId: "vault-shared" })
    ).resolves.toStrictEqual({ app: { id: "tally" }, alreadyInstalled: true });

    expect(wireLog()).toStrictEqual(["POST /centraid/_apps/_install"]);
    expect(
      sent("POST /centraid/_apps/_install").headers.get("x-centraid-vault")
    ).toBe("vault-shared");
  });

  it("law: an install that omits alreadyInstalled reads as a first install", async () => {
    respond("POST /centraid/_apps/_install", () =>
      json({ app: { id: "tally" } })
    );

    await expect(
      editing.installTemplate({ templateId: "tally" })
    ).resolves.toMatchObject({ alreadyInstalled: false });
  });

  it("law: renaming a BUNDLED app never opens a draft worktree", async () => {
    await expect(
      editing.renameInstalledApp({ id: "daily", name: "Daily" })
    ).resolves.toStrictEqual({ ok: true });

    expect(wireLog()).toStrictEqual(["POST /centraid/_apps/daily/meta"]);
    expect(sentJson("POST /centraid/_apps/daily/meta")).toStrictEqual({
      name: "Daily",
    });
  });

  it("law: a generated app's meta edit stages in its draft and publishes", async () => {
    await expect(
      editing.updateAppMeta({ id: "daily", description: "Runs daily" })
    ).resolves.toStrictEqual({ ok: true });

    expect(wireLog()).toStrictEqual([
      "POST /centraid/_apps/_sessions",
      "POST /centraid/_apps/daily/meta",
    ]);
    expect(sentJson("POST /centraid/_apps/daily/meta")).toStrictEqual({
      description: "Runs daily",
      sessionId: "desktop-daily",
      publish: true,
    });
  });

  it("law: a deleted app's draft session is closed only after the delete lands", async () => {
    await expect(editing.deleteApp({ id: "daily" })).resolves.toStrictEqual({
      ok: true,
    });

    expect(wireLog()).toStrictEqual([
      "DELETE /centraid/_apps/daily",
      "DELETE /centraid/_apps/_sessions/desktop-daily",
    ]);
  });

  it("law: a rejected delete leaves the draft session intact", async () => {
    respond(
      "DELETE /centraid/_apps/daily",
      () => new Response("in use", { status: 409 })
    );

    await expect(editing.deleteApp({ id: "daily" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(wireLog()).toStrictEqual(["DELETE /centraid/_apps/daily"]);
  });

  it("law: every lifecycle request carries the bearer token", async () => {
    await editing.installTemplate({ templateId: "tally" });

    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer token-1"
      )
    ).toBe(true);
  });
});
