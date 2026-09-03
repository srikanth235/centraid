import { describe, expect, test } from "vitest";

import type { VaultBridge } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { uuidv7 } from "@centraid/vault";

import type { VaultPlane } from "./vault-plane.js";
import {
  seedCalendar,
  silentLogger,
  usePlaneFixture,
} from "./vault-plane.test-fixtures.js";
import { openVaultRegistry } from "./vault-registry.js";

interface ConsentLifecycleCase {
  readonly plane: "app" | "agent";
  readonly entity: string;
  readonly enroll: (plane: VaultPlane) => VaultBridge;
  readonly approve: (plane: VaultPlane) => void;
  readonly grantsAfterApprove: (plane: VaultPlane) => unknown[] | undefined;
  readonly uninstall: (plane: VaultPlane) => { grantsRevoked: number };
  readonly denyErrorIncludes?: string;
  readonly allowedRows?: unknown[];
}

const consentLifecycle: readonly ConsentLifecycleCase[] = [
  {
    plane: "app",
    entity: "core.event",
    enroll: (plane) => {
      plane.enrollApp("planner");
      return plane.bridgeFor("planner");
    },
    approve: (plane) =>
      void plane.approveGrant("planner", {
        purpose: "dpv:ServiceProvision",
        scopes: [
          { schema: "schedule", verbs: "read+act" },
          { schema: "core", table: "event", verbs: "read" },
        ],
      }),
    grantsAfterApprove: (plane) =>
      plane.listApps().find((app) => app.name === "planner")?.grants,
    uninstall: (plane) => plane.revokeApp("planner"),
    denyErrorIncludes: "receipt",
    allowedRows: [],
  },
  {
    plane: "agent",
    entity: "schedule.task",
    enroll: (plane) => {
      plane.enrollAutomationAgent("briefing");
      plane.enrollAutomationAgent("briefing");
      expect(
        plane.listAgents().filter((agent) => agent.name === "Briefing")
      ).toHaveLength(1);
      return plane.agentBridgeFor("briefing");
    },
    approve: (plane) =>
      void plane.approveAgentGrant("briefing", {
        purpose: "dpv:ServiceProvision",
        scopes: [
          { schema: "schedule", verbs: "read+act" },
          { schema: "social", verbs: "read+act" },
          { schema: "core", table: "party", verbs: "read" },
        ],
      }),
    grantsAfterApprove: (plane) =>
      plane.listAgents().find((agent) => agent.name === "Briefing")?.grants,
    uninstall: (plane) => plane.revokeApp("briefing"),
  },
];

describe("vault-plane consent", () => {
  const fixture = usePlaneFixture();

  test.each(consentLifecycle)(
    "$plane plane: deny-by-default → owner grant → allowed → uninstall goes dark",
    async (scenario) => {
      const plane = fixture.openPlane(await tempDir());
      const bridge = scenario.enroll(plane);
      const read = () =>
        bridge({
          op: "read",
          payload: {
            entity: scenario.entity,
            purpose: "dpv:ServiceProvision",
          },
        });

      const denied = await read();
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("VAULT_ACCESS");
      expect(String(denied.error ?? "")).toContain(
        scenario.denyErrorIncludes ?? ""
      );

      scenario.approve(plane);
      expect(scenario.grantsAfterApprove(plane)).toHaveLength(1);
      const allowed = await read();
      expect(allowed.ok).toBe(true);
      expect(allowed.result).toMatchObject(
        scenario.allowedRows ? { rows: scenario.allowedRows } : {}
      );

      expect(scenario.uninstall(plane).grantsRevoked).toBe(1);
      const dark = await read();
      expect(dark.ok).toBe(false);
      expect(dark.code).toBe("VAULT_NOT_ENROLLED");
    }
  );

  test("agent plane: typed invokes replay by id and high risk parks for the owner", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.enrollAutomationAgent("briefing");
    plane.approveAgentGrant("briefing", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "social", verbs: "read+act" },
        { schema: "core", table: "party", verbs: "read" },
      ],
    });
    const bridge = plane.agentBridgeFor("briefing");

    const invoked = await bridge({
      op: "invoke",
      payload: {
        command: "schedule.add_task",
        input: { title: "follow up with the plumber" },
        purpose: "dpv:ServiceProvision",
        invocationId: "run-1:v0",
      },
    });
    expect(invoked.ok).toBe(true);
    expect(invoked.result).toMatchObject({
      status: "executed",
      invocationId: "run-1:v0",
    });

    const replayed = await bridge({
      op: "invoke",
      payload: {
        command: "schedule.add_task",
        input: { title: "follow up with the plumber" },
        purpose: "dpv:ServiceProvision",
        invocationId: "run-1:v0",
      },
    });
    expect(replayed.ok).toBe(true);
    expect(replayed.result).toMatchObject({ status: "replayed" });

    const ownerParty = plane.boot.ownerPartyId;
    const draft = await bridge({
      op: "invoke",
      payload: {
        command: "social.draft_message",
        input: {
          recipient_party_id: ownerParty,
          body_text: "your day, summarized",
        },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(draft.ok).toBe(true);
    const messageId = (draft.result as { output: { message_id: string } })
      .output.message_id;
    const send = await bridge({
      op: "invoke",
      payload: {
        command: "social.send_message",
        input: { message_id: messageId },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(send.ok).toBe(true);
    expect(send.result).toMatchObject({ status: "parked" });
    const parked = await bridge({ op: "parked", payload: {} });
    expect(parked.ok).toBe(true);
    expect(parked.result).toMatchObject([
      { command: "social.send_message", caller: "Briefing" },
    ]);
  });

  test("search op rides both bridges: FTS match vault-side, consent still one door", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_task (task_id, owner_party_id, title, description, status, priority)
       VALUES (?, ?, 'Chase the budget approval', 'ping finance about the Q3 budget', 'needs-action', 5)`
      )
      .run(uuidv7(), plane.boot.ownerPartyId);

    plane.enrollApp("tasks");
    const appBridge = plane.bridgeFor("tasks");
    const deniedApp = await appBridge({
      op: "search",
      payload: {
        entity: "schedule.task",
        query: "budget",
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(deniedApp.ok).toBe(false);
    expect(deniedApp.code).toBe("VAULT_ACCESS");
    plane.approveGrant("tasks", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read" }],
    });
    const appHit = await appBridge({
      op: "search",
      payload: {
        entity: "schedule.task",
        query: "budg",
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(appHit.ok).toBe(true);
    const appRows = (appHit.result as { rows: Record<string, unknown>[] }).rows;
    expect(appRows).toHaveLength(1);
    expect(String(appRows[0]?._snippet)).toContain("⟦budget⟧");

    plane.enrollAutomationAgent("chaser");
    plane.approveAgentGrant("chaser", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read" }],
    });
    const agentHit = await plane.agentBridgeFor("chaser")({
      op: "search",
      payload: {
        entity: "schedule.task",
        query: "finance budget",
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(agentHit.ok).toBe(true);
    expect((agentHit.result as { rows: unknown[] }).rows).toHaveLength(1);
  });

  test("sweep clock: expired grants lapse on the interval", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.enrollApp("planner");
    plane.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read" }],
      expiresAt: "2020-01-01T00:00:00Z",
    });
    expect(plane.listApps()[0]?.grants).toHaveLength(1);
    const result = plane.sweep();
    expect(result.grantsExpired).toBe(1);
    expect(plane.listApps()[0]?.grants).toHaveLength(0);
  });

  test("agent changes feed + app parked surface ride the bridges", async () => {
    const plane = fixture.openPlane(await tempDir());
    const calendarId = seedCalendar(plane);

    plane.enrollAutomationAgent("reconciler");
    plane.approveAgentGrant("reconciler", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "core", table: "event", verbs: "read" },
      ],
    });
    const agentBridge = plane.agentBridgeFor("reconciler");
    const bootstrap = await agentBridge({
      op: "changes",
      payload: {
        entities: ["core.event"],
        purpose: "dpv:ServiceProvision",
        cursor: null,
      },
    });
    expect(bootstrap.ok).toBe(true);
    const cursor = (bootstrap.result as { cursor: string }).cursor;

    plane.enrollApp("bookings");
    plane.approveGrant("bookings", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    plane.db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
        WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`
      )
      .run();
    const appBridge = plane.bridgeFor("bookings");
    const proposed = await appBridge({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Client call",
          dtstart: "2026-09-01T10:00:00Z",
          dtend: "2026-09-01T10:30:00Z",
          calendar_id: calendarId,
        },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(proposed.ok).toBe(true);
    expect((proposed.result as { status: string }).status).toBe("parked");

    const parked = await appBridge({ op: "parked", payload: {} });
    expect(parked.ok).toBe(true);
    expect(parked.result).toMatchObject([
      { command: "schedule.propose_event", caller: "Bookings" },
    ]);

    const invocationId = (parked.result as Array<{ invocationId: string }>)[0]!
      .invocationId;
    const confirmed = plane.confirmParked(invocationId, true);
    expect(confirmed.status).toBe("executed");
    const pull = await agentBridge({
      op: "changes",
      payload: {
        entities: ["core.event"],
        purpose: "dpv:ServiceProvision",
        cursor,
      },
    });
    expect(pull.ok).toBe(true);
    const changes = (pull.result as { changes: Array<{ entity: string }> })
      .changes;
    expect(changes.some((c) => c.entity === "core.event")).toBe(true);
  });

  test("owner routes: status, apps, grant, parked confirm, revoke", async () => {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    fixture.push(() => registry.stop());
    const plane = registry.current();
    const calendarId = seedCalendar(plane);
    plane.enrollApp("planner");
    const base = await fixture.serveOwnerRoutes(registry);

    const status = await (await fetch(`${base}/status`)).json();
    expect(status).toMatchObject({ vaultId: plane.boot.vaultId });

    const grantRes = await fetch(`${base}/apps/planner/grants`, {
      method: "POST",
      body: JSON.stringify({
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "schedule", verbs: "read+act" }],
      }),
    });
    expect(grantRes.status).toBe(200);
    const { grantId } = (await grantRes.json()) as { grantId: string };

    const apps = (await (await fetch(`${base}/apps`)).json()) as {
      apps: Array<{ name: string; grants: unknown[] }>;
    };
    expect(apps.apps[0]).toMatchObject({ name: "planner" });
    expect(apps.apps[0]?.grants).toHaveLength(1);

    plane.db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
        WHERE command_id = (SELECT command_id FROM agent_command WHERE name='schedule.propose_event')`
      )
      .run();
    const parked = await plane.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Owner check-in",
          dtstart: "2026-07-06T09:00:00Z",
          dtend: "2026-07-06T09:30:00Z",
          calendar_id: calendarId,
        },
        purpose: "dpv:ServiceProvision",
      },
    });
    const invocationId = (parked.result as { invocationId: string })
      .invocationId;
    const parkedList = (await (await fetch(`${base}/parked`)).json()) as {
      parked: unknown[];
    };
    expect(parkedList.parked).toHaveLength(1);
    expect(parkedList.parked[0]).toMatchObject({
      invocationId,
      command: "schedule.propose_event",
      callerKind: "app",
      caller: "Planner",
      input: { summary: "Owner check-in" },
    });
    const confirm = await fetch(`${base}/parked/${invocationId}`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    });
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { status: string }).status).toBe(
      "executed"
    );

    const revoke = await fetch(`${base}/grants/${grantId}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    const dark = await plane.bridgeFor("planner")({
      op: "read",
      payload: { entity: "core.event", purpose: "dpv:ServiceProvision" },
    });
    expect(dark.ok).toBe(false);

    const bad = await fetch(`${base}/apps/planner/grants`, {
      method: "POST",
      body: JSON.stringify({
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "s", verbs: "write" }],
      }),
    });
    expect(bad.status).toBe(400);
  });
});
