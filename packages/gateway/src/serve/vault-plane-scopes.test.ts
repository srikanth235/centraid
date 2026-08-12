// Install-time consent (issue #306) and what the owner may do to it afterwards
// (issue #308): installing IS the grant, widening a manifest parks as a scope
// request instead of auto-granting, a denial tombstones the ask, a revocation
// is never re-minted by the top-up, and the per-execution clamp still cuts the
// durable grant down to the anchor the run declared.
import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { seedCalendar, usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("vault-plane install scopes + execution clamps", () => {
  const fixture = usePlaneFixture();

  test("install-time scopes: enrolling grants the declared block, idempotently (issue #306)", async () => {
    const dir = await tempDir();
    const notificationsChanges: boolean[] = [];
    const plane = fixture.openPlaneWith({
      bootstrap: true,
      dir,
      ownerName: "Priya",
      onNotificationsChanged: (_vaultId, wake) =>
        notificationsChanges.push(wake),
    });
    const calendarId = seedCalendar(plane);

    // Installing IS the consent: no owner grant ceremony precedes the invoke.
    plane.ensureAppInstallGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    expect(notificationsChanges).toStrictEqual([]);
    const outcome = await plane.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Kickoff",
          dtstart: "2026-07-08T09:00:00Z",
          dtend: "2026-07-08T09:30:00Z",
          calendar_id: calendarId,
        },
      },
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { status: string }).status).toBe("executed");

    // Idempotent: re-running with the same block mints no second grant.
    const before = plane.listApps().find((a) => a.name === "planner")
      ?.grants.length;
    plane.ensureAppInstallGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const after = plane.listApps().find((a) => a.name === "planner")
      ?.grants.length;
    expect(after).toBe(before);
    // A widened declaration no longer auto-grants (issue #308 A3): agents
    // author their own manifests, so the ask parks as a blocking request.
    plane.ensureAppInstallGrant("planner", {
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "knowledge", verbs: "read" },
      ],
    });
    const widened = plane.listApps().find((a) => a.name === "planner");
    expect(widened?.grants.flatMap((g) => g.scopes) ?? []).toHaveLength(1);
    const requests = plane.listScopeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      plane: "app",
      appId: "planner",
      scopes: [{ schema: "knowledge", verbs: "read" }],
    });
    expect(plane.blocking().scopeRequests).toHaveLength(1);
    expect(notificationsChanges).toStrictEqual([true]);

    // The owner's approval mints exactly the asked scopes and closes the ask.
    plane.decideScopeRequest(requests[0]!.requestId, true);
    expect(notificationsChanges).toStrictEqual([true, false]);
    const approved = plane.listApps().find((a) => a.name === "planner");
    expect(approved?.grants.flatMap((g) => g.scopes) ?? []).toHaveLength(2);
    expect(plane.listScopeRequests()).toHaveLength(0);
    // With the grant landed, the same manifest asks for nothing more.
    plane.ensureAppInstallGrant("planner", {
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "knowledge", verbs: "read" },
      ],
    });
    expect(plane.listScopeRequests()).toHaveLength(0);
    expect(notificationsChanges).toStrictEqual([true, false]);

    // The agent-plane mirror covers automations.
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [{ schema: "outbox", verbs: "act" }],
    });
    const agents = plane.listAgents();
    expect(agents.find((a) => a.name === "Gmail Send")?.grants).toHaveLength(1);

    // The consent surface renders what was granted, salience included.
    const surface = plane.scopeSurface("planner");
    expect(surface.scopes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "app",
          schema: "schedule",
          verbs: "read+act",
        }),
      ])
    );
    expect(surface.highlights.some((h) => h.schema === "schedule")).toBe(true);
  });

  test("execution scope clamps preserve anchor minimization over an older broad grant", async () => {
    const plane = fixture.openPlane(await tempDir());
    const insert = plane.db.vault.prepare(
      `INSERT INTO schedule_task
       (task_id, owner_party_id, title, description, status, priority)
     VALUES (?, ?, ?, ?, 'needs-action', 5)`
    );
    insert.run(
      "task-1",
      plane.boot.ownerPartyId,
      "Visible title",
      "Hidden description"
    );
    insert.run(
      "task-2",
      plane.boot.ownerPartyId,
      "Other title",
      "Other description"
    );
    const scope = {
      schema: "schedule",
      table: "task",
      verbs: "read" as const,
      rowFilter: [{ column: "task_id", op: "eq" as const, value: "task-1" }],
      fieldMask: ["task_id", "title"],
    };
    plane.ensureAgentInstallGrant("anchored-automation", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read" }],
    });
    // Recompiling with an anchor cannot make an older, broader owner grant
    // disappear. The execution credential must still attenuate it.
    plane.ensureAgentInstallGrant("anchored-automation", {
      purpose: "dpv:ServiceProvision",
      scopes: [scope],
    });
    const read = await plane.agentBridgeFor("anchored-automation", {
      purpose: "dpv:ServiceProvision",
      scopes: [scope],
    })({
      op: "read",
      payload: { entity: "schedule.task", purpose: "dpv:ServiceProvision" },
    });
    expect(read).toMatchObject({
      ok: true,
      result: { rows: [{ task_id: "task-1", title: "Visible title" }] },
    });
    expect(
      plane
        .listAgents()
        .find((agent) => agent.enrollmentKey === "anchored-automation")
        ?.grants[0]?.scopes[0]
    ).toMatchObject({ schema: "schedule", table: "task", verbs: "read" });
    const grantId = plane
      .listAgents()
      .find((agent) => agent.enrollmentKey === "anchored-automation")!
      .grants[0]!.grantId;
    plane.revokeGrant(grantId);
    plane.ensureAgentInstallGrant("anchored-automation", {
      purpose: "dpv:ServiceProvision",
      scopes: [scope],
    });
    expect(
      plane
        .listAgents()
        .find((agent) => agent.enrollmentKey === "anchored-automation")?.grants
    ).toHaveLength(0);
  });

  test("an execution with no declared vault scopes cannot ride historical agent consent", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAgentInstallGrant("scope-less-automation", {
      scopes: [{ schema: "schedule", table: "task", verbs: "read" }],
    });
    const read = await plane.agentBridgeFor("scope-less-automation", {
      scopes: [],
    })({
      op: "read",
      payload: { entity: "schedule.task" },
    });
    expect(read).toMatchObject({
      ok: false,
      code: "VAULT_CONSENT",
      error: expect.stringContaining(
        "execution manifest does not declare schedule.task"
      ),
    });
  });

  test("owner narrowing is durable: a revoked grant is not re-minted by the top-up (issue #308 A4)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const block = {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" as const }],
    };
    plane.ensureAppInstallGrant("planner", block);
    const granted = plane.listApps().find((a) => a.name === "planner");
    expect(granted?.grants).toHaveLength(1);

    // The owner tightens: revoke the install grant.
    plane.revokeGrant(granted!.grants[0]!.grantId);
    expect(
      plane.listApps().find((a) => a.name === "planner")?.grants
    ).toHaveLength(0);

    // Mount/sync/publish re-run the top-up — the revocation survives all of
    // them: no re-mint, and no nagging scope request either (the owner said no).
    plane.ensureAppInstallGrant("planner", block);
    plane.ensureAppInstallGrant("planner", block);
    expect(
      plane.listApps().find((a) => a.name === "planner")?.grants
    ).toHaveLength(0);
    expect(plane.listScopeRequests()).toHaveLength(0);

    // Only an explicit owner approval brings the scope back…
    plane.approveGrant("planner", block);
    expect(
      plane.listApps().find((a) => a.name === "planner")?.grants
    ).toHaveLength(1);
    // …and from then on the top-up treats it as consented again.
    plane.ensureAppInstallGrant("planner", block);
    expect(
      plane.listApps().find((a) => a.name === "planner")?.grants
    ).toHaveLength(1);
  });

  test("a denied scope request stops re-asking; uninstall wipes the memory (issue #308 A3/A4)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAppInstallGrant("planner", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const widenedBlock = {
      scopes: [
        { schema: "schedule", verbs: "read+act" as const },
        { schema: "knowledge", verbs: "read" as const },
      ],
    };
    plane.ensureAppInstallGrant("planner", widenedBlock);
    const request = plane.listScopeRequests()[0]!;
    plane.decideScopeRequest(request.requestId, false);
    expect(plane.listScopeRequests()).toHaveLength(0);
    // The same manifest on the next mount does not re-ask — denial tombstoned it.
    plane.ensureAppInstallGrant("planner", widenedBlock);
    expect(plane.listScopeRequests()).toHaveLength(0);
    expect(
      plane.listApps().find((a) => a.name === "planner")?.grants
    ).toHaveLength(1);

    // Uninstall wipes tombstones and open requests: reinstalling is a fresh
    // install-time consent for whatever the manifest then declares.
    plane.revokeApp("planner");
    plane.ensureAppInstallGrant("planner", widenedBlock);
    const reinstalled = plane.listApps().find((a) => a.name === "planner");
    expect(reinstalled?.grants.flatMap((g) => g.scopes)).toHaveLength(2);
    expect(plane.listScopeRequests()).toHaveLength(0);
  });

  test("the agent plane mirrors the widening park (issue #308 A3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [{ schema: "outbox", verbs: "act" }],
    });
    expect(
      plane.listAgents().find((a) => a.name === "Gmail Send")?.grants
    ).toHaveLength(1);
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [
        { schema: "outbox", verbs: "act" },
        { schema: "social", verbs: "read+act" },
      ],
    });
    const requests = plane.listScopeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ plane: "agent", appId: "gmail-send" });
    plane.decideScopeRequest(requests[0]!.requestId, true);
    const scopes = plane
      .listAgents()
      .find((a) => a.name === "Gmail Send")
      ?.grants.flatMap((g) => g.scopes);
    expect(scopes).toHaveLength(2);
  });
});
