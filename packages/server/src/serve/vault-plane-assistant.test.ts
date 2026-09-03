import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("vault-plane assistant", () => {
  const fixture = usePlaneFixture();

  test("invokeAsAssistant: low-risk executes under a standing grant, high-risk parks (#286 phase 2)", async () => {
    const plane = fixture.openPlane(await tempDir());

    const created = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "From the assistant", body_text: "hello" },
      purpose: "dpv:ServiceProvision",
    });
    expect(created.status).toBe("executed");

    const again = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "Second", body_text: "again" },
      purpose: "dpv:ServiceProvision",
    });
    expect(again.status).toBe("executed");
    const agents = plane.db.vault
      .prepare(`SELECT count(*) AS n FROM access_agent`)
      .get() as {
      n: number;
    };
    expect(agents.n).toBe(1);

    const risky = await plane.invokeAsAssistant({
      command: "social.send_message",
      input: { message_id: "not-yet-real" },
      purpose: "dpv:ServiceProvision",
    });
    expect(risky.status).toBe("parked");
    expect(
      plane.listParked().some((p) => p.command === "social.send_message")
    ).toBe(true);

    const credentialGrab = await plane.invokeAsAssistant({
      command: "sync.configure_credential",
      input: {
        kind: "pull.gmail",
        label: "personal",
        cred_kind: "api_key",
        api_key: "sk-x",
        allowed_hosts: ["attacker.example"],
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(credentialGrab.status).toBe("parked");
  });

  test("the assistant self-heal respects owner narrowing — a revoked schema stays revoked (issue #308 B3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const created = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "Before narrowing", body_text: "x" },
      purpose: "dpv:ServiceProvision",
    });
    expect(created.status).toBe("executed");
    const assistant = plane.listAgents().find((a) => a.name === "Assistant");
    expect(assistant?.grants.length).toBeGreaterThan(0);
    for (const grant of assistant!.grants) plane.revokeGrant(grant.grantId);

    const denied = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "After narrowing", body_text: "y" },
      purpose: "dpv:ServiceProvision",
    });
    expect(denied.status).toBe("denied");

    plane.approveAgentGrant("_assistant", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "knowledge", verbs: "act" }],
    });
    const healed = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "Re-approved", body_text: "z" },
      purpose: "dpv:ServiceProvision",
    });
    expect(healed.status).toBe("executed");
  });
});
