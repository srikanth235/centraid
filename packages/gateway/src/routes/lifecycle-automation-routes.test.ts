import crypto from "node:crypto";
/*
 * `POST /centraid/_automations/update?ref=` — the instructions-first
 * editor's save path (automations UI revamp). Boots a real gateway and
 * drives the wire path end to end, mirroring
 * `../lifecycle/automation-lifecycle-over-http.test.ts`'s style for the
 * sibling create/set-enabled/rotate-webhook/delete routes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { hashWebhookSecret } from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { describe, afterEach, beforeEach, expect, test, vi } from "vitest";

import type { GatewayPaths } from "../paths.ts";
import { serve, type GatewayServeHandle } from "../serve/serve.ts";
// lifecycle-automation-routes is exercised through serve() HTTP paths below (#545 B3).

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

interface CreatedAutomation {
  row: {
    ref: string;
    manifest: {
      name: string;
      prompt: string;
      triggers: unknown[];
      requires?: { runner?: string; model?: string };
    };
  };
  webhook?: { id: string; secret: string; url: string };
}

/** Scaffold + publish a fresh automation app via the real create route. */
async function createAutomation(
  id: string,
  body: Record<string, unknown> = {}
): Promise<CreatedAutomation> {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name: id,
      prompt: "do the thing",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      publish: true,
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreatedAutomation;
}

async function update(
  ref: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${handle.url}/centraid/_automations/update?ref=${encodeURIComponent(ref)}`,
    {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ publish: true, ...body }),
    }
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe("lifecycle-automation-routes scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-autoupdate-${crypto.randomUUID()}-`);
    // Headless compile (and any builder turn) would spawn a real coding agent
    // and hang on agentless CI/local hosts. Inject a failing runTurn so the
    // compile path still exercises ledger finish + HTTP 202 without ACP.
    handle = await serve({
      paths: pathsUnder(dataDir),
      runTurn: async () => {
        throw new Error("compiler unavailable");
      },
    });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("create mints a webhook plaintext once and persists only the hash", async () => {
    const created = await createAutomation("minted-hook", {
      triggers: [{ kind: "webhook" }],
    });
    expect(created.webhook).toBeTruthy();
    const secret = created.webhook!.secret;
    expect(secret.length).toBeGreaterThan(16);
    const trigger = created.row.manifest.triggers[0] as {
      kind: string;
      id: string;
      secretHash: string;
    };
    expect(trigger.kind).toBe("webhook");
    expect(trigger.id).toBe(created.webhook!.id);
    // Plaintext is returned once; the manifest stores only SHA-256(secret).
    expect(trigger.secretHash).toBe(hashWebhookSecret(secret));
    expect(JSON.stringify(created.row.manifest)).not.toContain(secret);
  });

  test("update patches only the name, leaving prompt/triggers untouched", async () => {
    const created = await createAutomation("renamer");
    const { status, json } = await update(created.row.ref, {
      name: "Renamed Automation",
    });
    expect(status).toBe(200);
    const row = json.row as {
      manifest: { name: string; prompt: string; triggers: unknown[] };
    };
    expect(row.manifest.name).toBe("Renamed Automation");
    expect(row.manifest.prompt).toBe("do the thing");
    expect(row.manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 9 * * *" },
    ]);
  });

  test("update patches only the prompt, leaving name/triggers untouched", async () => {
    const created = await createAutomation("reprompter");
    const { status, json } = await update(created.row.ref, {
      prompt: "do a different thing now",
    });
    expect(status).toBe(200);
    const row = json.row as {
      manifest: { name: string; prompt: string; triggers: unknown[] };
    };
    expect(row.manifest.prompt).toBe("do a different thing now");
    expect(row.manifest.name).toBe("reprompter");
    expect(row.manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 9 * * *" },
    ]);
  });

  test("create/update persist runner and model pins, and null clears both", async () => {
    const created = await createAutomation("pinned-agent", {
      runner: "claude-code",
      model: "claude-custom",
    });
    expect(created.row.manifest.requires).toStrictEqual({
      runner: "claude-code",
      model: "claude-custom",
    });

    const changed = await update(created.row.ref, {
      runner: "codex",
      model: "gpt-custom",
    });
    expect(changed.status).toBe(200);
    expect(
      (changed.json.row as { manifest: { requires: Record<string, unknown> } })
        .manifest.requires
    ).toStrictEqual({ runner: "codex", model: "gpt-custom" });

    const cleared = await update(created.row.ref, {
      runner: null,
      model: null,
    });
    expect(cleared.status).toBe(200);
    expect(
      (cleared.json.row as { manifest: { requires: Record<string, unknown> } })
        .manifest.requires
    ).toStrictEqual({});
  });

  test("update replaces a cron trigger with a different cron expression", async () => {
    const created = await createAutomation("rescheduler");
    const { status, json } = await update(created.row.ref, {
      triggers: [{ kind: "cron", expr: "0 * * * *" }],
    });
    expect(status).toBe(200);
    const row = json.row as { manifest: { triggers: unknown[] } };
    expect(row.manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 * * * *" },
    ]);
  });

  test("create/update round-trip declarative connector event triggers", async () => {
    const connections = [
      {
        connectionId: "github-account-1",
        kind: "pull.github",
        label: "Work GitHub",
      },
    ];
    const created = await createAutomation("provider-events", {
      connections,
      triggers: [
        {
          kind: "event",
          connectorKind: "pull.github",
          event: "pull-request",
          filter: { repo: "acme/app" },
        },
      ],
    });
    expect(created.row.manifest.triggers).toStrictEqual([
      {
        kind: "event",
        connectorKind: "pull.github",
        event: "pull-request",
        filter: { repo: "acme/app" },
      },
    ]);

    const changed = await update(created.row.ref, {
      connections,
      triggers: [
        {
          kind: "event",
          connectorKind: "pull.github",
          event: "issue",
          filter: { repo: "acme/app" },
          every: "*/2 * * * *",
        },
      ],
    });
    expect(changed.status).toBe(200);
    expect(
      (changed.json.row as { manifest: { triggers: unknown[] } }).manifest
        .triggers
    ).toStrictEqual([
      {
        kind: "event",
        connectorKind: "pull.github",
        event: "issue",
        filter: { repo: "acme/app" },
        every: "*/2 * * * *",
      },
    ]);
  });

  test("update mints a fresh webhook when the automation had none before", async () => {
    const created = await createAutomation("gains-a-hook", {
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    });
    const { status, json } = await update(created.row.ref, {
      triggers: [{ kind: "webhook" }],
    });
    expect(status).toBe(200);
    expect(json.webhook).toBeTruthy();
    const webhook = json.webhook as { id: string; secret: string; url: string };
    expect(webhook.id).toBeTruthy();
    expect(webhook.secret).toBeTruthy();
    expect(webhook.url).toMatch(/\/_centraid-hook\//u);
    const row = json.row as {
      manifest: { triggers: Array<{ kind: string; id?: string }> };
    };
    expect(row.manifest.triggers).toStrictEqual([
      {
        kind: "webhook",
        id: webhook.id,
        secretHash: hashWebhookSecret(webhook.secret),
      },
    ]);
    expect(JSON.stringify(row.manifest)).not.toContain(webhook.secret);
  });

  test("update keeps an existing webhook trigger secret untouched when re-declared", async () => {
    const created = await createAutomation("keeps-its-hook", {
      triggers: [{ kind: "webhook" }],
    });
    expect(created.webhook).toBeTruthy();
    const originalSecretHash = (
      created.row.manifest.triggers[0] as {
        kind: string;
        id: string;
        secretHash: string;
      }
    ).secretHash;

    // Rename in the same edit that re-declares the webhook trigger — the
    // webhook entry must be a no-op (no fresh mint, no `webhook` in the
    // response) since it already existed.
    const { status, json } = await update(created.row.ref, {
      name: "Keeps Its Hook (renamed)",
      triggers: [{ kind: "webhook" }],
    });
    expect(status).toBe(200);
    expect(json.webhook).toBeUndefined();
    const row = json.row as {
      manifest: {
        name: string;
        triggers: Array<{ kind: string; id: string; secretHash: string }>;
      };
    };
    expect(row.manifest.name).toBe("Keeps Its Hook (renamed)");
    expect(row.manifest.triggers).toStrictEqual([
      {
        kind: "webhook",
        id: created.webhook!.id,
        secretHash: originalSecretHash,
      },
    ]);
  });

  test("update drops a webhook trigger when triggers omits it", async () => {
    const created = await createAutomation("loses-its-hook", {
      triggers: [{ kind: "webhook" }],
    });
    const { status, json } = await update(created.row.ref, {
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    });
    expect(status).toBe(200);
    const row = json.row as { manifest: { triggers: unknown[] } };
    expect(row.manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 9 * * *" },
    ]);
  });

  test("update on an unknown ref is a 404", async () => {
    const { status, json } = await update("nope/nope", { name: "ghost" });
    expect(status).toBe(404);
    expect(json.error).toBe("not_found");
  });

  test("update rejects an unsupported trigger kind with a 400", async () => {
    const created = await createAutomation("bad-trigger-kind");
    const { status, json } = await update(created.row.ref, {
      triggers: [{ kind: "carrier-pigeon" }],
    });
    expect(status).toBe(400);
    expect(json.error).toBe("bad_request");
    expect(json.message).toContain("carrier-pigeon");
  });

  test("update rejects a malformed condition trigger with the validator field-scoped message", async () => {
    const created = await createAutomation("bad-condition-trigger");
    const { status, json } = await update(created.row.ref, {
      triggers: [
        { kind: "condition", entity: "core.invoice", where: "not-an-array" },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toBe("bad_request");
    expect(json.message).toContain("where");
  });

  test("update with no recognized fields is a 400", async () => {
    const created = await createAutomation("empty-patch");
    const { status, json } = await update(created.row.ref, {});
    expect(status).toBe(400);
    expect(json.error).toBe("bad_request");
  });

  test("headless compile returns a turn id and records failure in the automation thread", async () => {
    const created = await createAutomation("compile-ledger", {
      enabled: false,
    });
    const res = await fetch(
      `${handle.url}/centraid/_automations/compile?ref=${encodeURIComponent(created.row.ref)}`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ enableOnSuccess: true }),
      }
    );
    expect(res.status).toBe(202);
    const { compileTurnId } = (await res.json()) as { compileTurnId: string };
    expect(compileTurnId).toContain(":compile:");

    // Wait on a wall-clock deadline, not an iteration count. A compile spawns a
    // real app-server subprocess; the old 20x25ms budget was 500ms, which a
    // loaded CI runner blows through routinely. When it expired the loop simply
    // fell through and the assertions below still passed against a run row that
    // had not ended yet — so the test proved nothing it claimed, and afterEach
    // then deleted the data dir while the compile was still writing objects into
    // code/apps.git, surfacing as ENOTEMPTY from an unrelated-looking rm.
    // Asserting endedAt is what makes the wait real: the run must be over before
    // this test returns, which is also what makes teardown safe.
    // #496 H1 — poll with vi.waitFor rather than a fixed-sleep loop.
    await vi.waitFor(
      async () => {
        const feed = await fetch(
          `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(created.row.ref)}`,
          { headers: auth() }
        );
        const body = (await feed.json()) as {
          turns: Array<{
            turnId: string;
            triggerKind: string;
            endedAt?: number | null;
            ok: boolean | null;
          }>;
        };
        const found = body.turns.find(
          (candidate) => candidate.turnId === compileTurnId
        );
        // Terminal failure: ok is false AND endedAt is a number. Accepting
        // endedAt null/undefined reduced the wait to `ok === false` and
        // reinstated the ENOTEMPTY teardown race this comment warns about —
        // the run must be fully over before this test returns.
        expect(found).toMatchObject({ triggerKind: "compile", ok: false });
        expect(found?.endedAt).toBeTypeOf("number");
      },
      { timeout: 30_000, interval: 100 }
    );
  }, 35_000);

  test("headless compile failover settles one ledger turn per provider before publishing", async () => {
    await handle.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = await tempDir(`gw-compile-failover-${crypto.randomUUID()}-`);
    const attempted: string[] = [];
    handle = await serve({
      paths: pathsUnder(dataDir),
      runTurn: async (input, config) => {
        const runner = config.prefs.kind;
        attempted.push(runner);
        if (runner === "codex") {
          input.onEvent({
            type: "error",
            message: "codex failed to spawn",
            failureClass: "spawn",
          });
        } else {
          input.onEvent({ type: "final", text: "Plan ready" });
        }
        return { adapterKind: runner };
      },
    });
    handle.prefs.setPrefs({
      "runner.automations": "codex",
      "runner.ladder.automations": ["codex", "claude-code"],
    });

    const created = await createAutomation("compile-failover", {
      enabled: false,
    });
    const res = await fetch(
      `${handle.url}/centraid/_automations/compile?ref=${encodeURIComponent(created.row.ref)}`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ enableOnSuccess: true }),
      }
    );
    expect(res.status).toBe(202);
    const { compileTurnId } = (await res.json()) as { compileTurnId: string };

    await vi.waitFor(
      async () => {
        const feed = await fetch(
          `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(created.row.ref)}`,
          { headers: auth() }
        );
        const body = (await feed.json()) as {
          turns: Array<{
            turnId: string;
            note?: string;
            endedAt?: number | null;
            ok: boolean | null;
          }>;
        };
        const first = body.turns.find(
          (candidate) => candidate.turnId === compileTurnId
        );
        const fallback = body.turns.find((candidate) =>
          candidate.turnId.startsWith(`${compileTurnId}:failover:1:claude-code`)
        );
        expect(first).toMatchObject({
          note: "Compiling plan with codex",
          ok: false,
        });
        expect(first?.endedAt).toBeTypeOf("number");
        expect(fallback).toMatchObject({
          note:
            "codex failed at the compile boundary (spawn). Continuing with claude-code; " +
            "provider-specific model and effort pins were cleared.",
          ok: true,
        });
        expect(fallback?.endedAt).toBeTypeOf("number");
      },
      { timeout: 30_000, interval: 100 }
    );
    expect(attempted).toStrictEqual(["codex", "claude-code"]);
  }, 35_000);

  test("headless revision validates steering and returns the compile turn id immediately", async () => {
    const created = await createAutomation("revise-ledger", { enabled: false });
    const endpoint = `${handle.url}/centraid/_automations/revise?ref=${encodeURIComponent(created.row.ref)}`;
    const empty = await fetch(endpoint, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Only include messages from customers.",
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { compileTurnId: string };
    expect(body.compileTurnId).toMatch(
      /^revise-ledger\/revise-ledger:compile:[0-9a-f]{8}$/u
    );
    const revisionTurnId = body.compileTurnId.replace(":compile:", ":revise:");
    await vi.waitFor(
      async () => {
        const feed = await fetch(
          `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(created.row.ref)}`,
          { headers: auth() }
        );
        const turns = (
          (await feed.json()) as {
            turns: Array<{
              turnId: string;
              ok: boolean;
              endedAt?: number;
              error?: string;
            }>;
          }
        ).turns;
        const revision = turns.find((turn) => turn.turnId === revisionTurnId);
        const compile = turns.find(
          (turn) => turn.turnId === body.compileTurnId
        );
        expect(revision?.ok).toBe(false);
        expect(revision?.endedAt).toBeTypeOf("number");
        expect(compile).toMatchObject({
          ok: false,
          error: expect.stringContaining("Instruction revision failed"),
        });
        expect(compile?.endedAt).toBeTypeOf("number");
      },
      { timeout: 10_000, interval: 50 }
    );
  });
});
