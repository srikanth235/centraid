// Consent as it is felt through the plane's bridges: deny-by-default until the
// owner grants, allow while the grant lives, dark the moment the app or agent
// is uninstalled — plus the owner's own HTTP routes for the same acts, the
// sweep clock that lapses expired grants, and the feeds that ride the bridges.
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

/**
 * The app plane and the agent plane are two doors onto ONE consent law. The
 * lifecycle below is that law; everything a single plane adds on top of it
 * (replay, parking, install-time top-ups) lives in its own test.
 */
interface ConsentLifecycleCase {
  readonly plane: "app" | "agent";
  readonly entity: string;
  /** Enroll the caller, then hand back its bridge. */
  readonly enroll: (plane: VaultPlane) => VaultBridge;
  readonly approve: (plane: VaultPlane) => void;
  /** Grants visible to the owner once the approval lands. */
  readonly grantsAfterApprove: (plane: VaultPlane) => unknown[] | undefined;
  readonly uninstall: (plane: VaultPlane) => { grantsRevoked: number };
  /** Substring the deny must carry, where the plane promises one. */
  readonly denyErrorIncludes?: string;
  /** Rows the granted read must return, where the fixture pins them. */
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
    // The deny is receipted, and says so — a hang or a silent empty read would
    // both pass a bare `ok === false`.
    denyErrorIncludes: "receipt",
    allowedRows: [],
  },
  {
    plane: "agent",
    entity: "schedule.task",
    enroll: (plane) => {
      plane.enrollAutomationAgent("briefing");
      // Idempotent — the reconcile loop calls this on every settle.
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

      // Enrolled but ungranted: a receipted consent deny, not a hang or a leak.
      const denied = await read();
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("VAULT_ACCESS");
      // Unconditional: a plane that promises nothing asserts against "", which
      // every string contains. A conditional assertion would silently vanish
      // if a scenario ever dropped the field.
      expect(String(denied.error ?? "")).toContain(
        scenario.denyErrorIncludes ?? ""
      );

      // The owner approves the manifest-declared scopes.
      scenario.approve(plane);
      expect(scenario.grantsAfterApprove(plane)).toHaveLength(1);
      const allowed = await read();
      expect(allowed.ok).toBe(true);
      expect(allowed.result).toMatchObject(
        scenario.allowedRows ? { rows: scenario.allowedRows } : {}
      );

      // Uninstall: grants revoked (cascade), identity retired, calls go dark.
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

    // A typed command executes under the agent identity (risk low).
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

    // Replay: the same invocationId returns the recorded outcome, no double write.
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

    // Risk high > agent ceiling (medium): parks for the owner; the agent's own
    // parked surface lists it.
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

    // Agent side: watch core.event through the consented change feed.
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

    // An app parks a confirm-gated booking request (#306: parking is a
    // property of the command, not of risk)…
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
    // …a write that, once confirmed, lands in the agent's feed.
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

    // The parked op shows the app ITS pending approval (#260 seam).
    const parked = await appBridge({ op: "parked", payload: {} });
    expect(parked.ok).toBe(true);
    expect(parked.result).toMatchObject([
      { command: "schedule.propose_event", caller: "Bookings" },
    ]);

    // Owner confirms → the write lands → the agent's next pull sees it.
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
    // The route handler speaks to the registry; the acts land on its active plane.
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

    // Approve the requested scopes over HTTP — the owner act.
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

    // Park an invocation through the bridge, confirm it over HTTP. Parking
    // is confirm-gated (#306): mark the command loud-on-purpose first.
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
    // The wire carries WHO and WHAT so the desktop confirmation UI can
    // render "Planner wants schedule.propose_event: …" (issue: consent UX,
    // parked-invocation trust legibility — the display name, not the raw
    // enrollment slug).
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

    // Revoke over HTTP; the app goes dark.
    const revoke = await fetch(`${base}/grants/${grantId}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    const dark = await plane.bridgeFor("planner")({
      op: "read",
      payload: { entity: "core.event", purpose: "dpv:ServiceProvision" },
    });
    expect(dark.ok).toBe(false);

    // Bad grant bodies are refused.
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
