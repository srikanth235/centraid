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

describe("app lifecycle seam", () => {
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
