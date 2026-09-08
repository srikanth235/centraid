// INSTALL, ANSWER, CLAMP — the three different things #928 stopped conflating.
//
// A first-party app INSTALLS: its reach is the manifest its own code declares,
// so it holds no answer, never parks and never asks. An automation is a
// PRINCIPAL: install-time is the owner's answer for what was declared then, a
// later widening parks as a blocking ask instead of auto-answering, a refusal
// is a `declined` row that stops the next mount re-asking, and a withdrawal is
// never re-minted by the top-up. The per-execution CLAMP still cuts a run down
// to the manifest it was launched with, whatever the answer says.
import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { seedCalendar, usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("vault-plane install scopes + execution clamps", () => {
  const fixture = usePlaneFixture();

  const answersOf = (
    plane: ReturnType<typeof fixture.openPlane>,
    key: string
  ) =>
    plane.listAgents().find((agent) => agent.enrollmentKey === key)?.answers ??
    [];

  test("an app DECLARES: installing mints no answer, and a widening never parks (#928 A1)", async () => {
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

    plane.recordAppInstall("planner", {
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

    // A widened DECLARATION is just a newer build of the app's own code. It
    // parks nothing and asks nobody: the entity tripwire is what holds an app
    // to what it declared, at build time, before this vault ever saw it.
    plane.recordAppInstall("planner", {
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "knowledge", verbs: "read" },
      ],
    });
    expect(plane.listScopeRequests()).toHaveLength(0);
    expect(plane.blocking().scopeRequests).toHaveLength(0);
    expect(notificationsChanges).toStrictEqual([]);

    // The surface renders what the app DECLARED, salience included.
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

  test("an automation's install-time answer is minted once, idempotently (#306)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [{ schema: "outbox", verbs: "act" }],
    });
    expect(answersOf(plane, "gmail-send")).toHaveLength(1);
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [{ schema: "outbox", verbs: "act" }],
    });
    expect(answersOf(plane, "gmail-send")).toHaveLength(1);
    expect(plane.listScopeRequests()).toHaveLength(0);
  });

  test("a widened automation manifest PARKS, and the owner's yes closes the ask (#308 A3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [{ schema: "outbox", verbs: "act" }],
    });
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [
        { schema: "outbox", verbs: "act" },
        { schema: "social", verbs: "read+act" },
      ],
    });
    // Parked, not answered: the widened subject is absent until it is decided.
    expect(answersOf(plane, "gmail-send")).toHaveLength(1);
    const requests = plane.listScopeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ principalId: "gmail-send" });
    expect(plane.blocking().scopeRequests).toHaveLength(1);

    plane.decideScopeRequest(requests[0]!.requestId, true);
    expect(plane.listScopeRequests()).toHaveLength(0);
    // outbox act + social read + social act
    expect(answersOf(plane, "gmail-send")).toHaveLength(3);
    // With the answer landed, the same manifest asks for nothing more.
    plane.ensureAgentInstallGrant("gmail-send", {
      scopes: [
        { schema: "outbox", verbs: "act" },
        { schema: "social", verbs: "read+act" },
      ],
    });
    expect(plane.listScopeRequests()).toHaveLength(0);
  });

  test("execution scope clamps preserve anchor minimization over a broader answer", async () => {
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
      scopes: [{ schema: "schedule", table: "task", verbs: "read" }],
    });
    // The RUN's clamp is what narrows rows and fields; the owner's answer says
    // only whether this entity is reachable for reading at all (#928).
    const read = await plane.agentBridgeFor("anchored-automation", {
      scopes: [scope],
    })({
      op: "read",
      payload: { entity: "schedule.task" },
    });
    expect(read).toMatchObject({
      ok: true,
      result: { rows: [{ task_id: "task-1", title: "Visible title" }] },
    });
    expect(answersOf(plane, "anchored-automation")[0]).toMatchObject({
      subjectType: "core.entity",
      subjectId: "schedule.task",
      verb: "read",
      decision: "granted",
    });
  });

  test("an execution with no declared vault scopes cannot ride a historical answer", async () => {
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
      code: "VAULT_ACCESS",
      error: expect.stringContaining(
        "execution manifest does not declare schedule.task"
      ),
    });
  });

  test("owner narrowing is durable: a withdrawn answer is not re-minted by the top-up (#308 A4)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const block = {
      scopes: [{ schema: "schedule", verbs: "read+act" as const }],
    };
    plane.ensureAgentInstallGrant("digest", block);
    const held = answersOf(plane, "digest");
    expect(held).toHaveLength(2);

    // The owner tightens: withdraw both standing answers.
    for (const answer of held) plane.revokeAuthority(answer.authorityId);
    expect(answersOf(plane, "digest")).toHaveLength(0);

    // Mount/sync/publish re-run the top-up. A withdrawal is not a refusal, so
    // the ask comes BACK — parked for the owner, never silently re-minted.
    plane.ensureAgentInstallGrant("digest", block);
    plane.ensureAgentInstallGrant("digest", block);
    expect(answersOf(plane, "digest")).toHaveLength(0);
    expect(plane.listScopeRequests()).toHaveLength(1);

    // Only an explicit owner approval brings the answer back.
    plane.decideScopeRequest(plane.listScopeRequests()[0]!.requestId, true);
    expect(answersOf(plane, "digest")).toHaveLength(2);
    plane.ensureAgentInstallGrant("digest", block);
    expect(plane.listScopeRequests()).toHaveLength(0);
  });

  test("a refusal stops the re-asking; uninstall wipes the memory (#308 A3/A4)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.ensureAgentInstallGrant("digest", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const widenedBlock = {
      scopes: [
        { schema: "schedule", verbs: "read+act" as const },
        { schema: "knowledge", verbs: "read" as const },
      ],
    };
    plane.ensureAgentInstallGrant("digest", widenedBlock);
    const request = plane.listScopeRequests()[0]!;
    plane.decideScopeRequest(request.requestId, false);
    expect(plane.listScopeRequests()).toHaveLength(0);
    // A REFUSAL IS AN ANSWER: the same manifest on the next mount does not
    // re-ask, because "told no" is a row, not an absence.
    plane.ensureAgentInstallGrant("digest", widenedBlock);
    expect(plane.listScopeRequests()).toHaveLength(0);
    expect(
      answersOf(plane, "digest").filter((a) => a.decision === "declined")
    ).toHaveLength(1);

    // Uninstall wipes the memory: reinstalling is a fresh install-time answer
    // for whatever the manifest then declares.
    plane.revokeApp("digest");
    plane.ensureAgentInstallGrant("digest", widenedBlock);
    expect(
      answersOf(plane, "digest").filter((a) => a.decision === "granted")
    ).toHaveLength(3);
    expect(plane.listScopeRequests()).toHaveLength(0);
  });
});
