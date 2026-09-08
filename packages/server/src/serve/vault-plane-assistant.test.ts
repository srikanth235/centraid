// The vault assistant (`_assistant`, #286 phase 2) is a first-class non-owner
// caller that holds NO standing answer (#928 A3): its reach is the acting
// owner's, confirm-gated commands still park, and with nobody behind the call
// it holds nothing at all.
import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { evaluateAccess } from "@centraid/vault";

import { runWithVaultContext } from "./vault-context.js";
import type { VaultPlane } from "./vault-plane.js";
import { usePlaneFixture } from "./vault-plane.test-fixtures.js";

/** The shell's own frame: an owner, on their own vault. */
function asOwner<T>(plane: VaultPlane, run: () => Promise<T>): Promise<T> {
  return runWithVaultContext(
    {
      vaultId: plane.boot.vaultId,
      ownerId: plane.boot.ownerPartyId,
      ownsVault: true,
    },
    run
  );
}

describe("vault-plane assistant", () => {
  const fixture = usePlaneFixture();

  test("invokeAsAssistant: low-risk executes on the owner's behalf, high-risk parks (#286 phase 2)", async () => {
    const plane = fixture.openPlane(await tempDir());

    // First use mints the `_assistant` agent — and NO grant (#928 A3).
    const created = await asOwner(plane, () =>
      plane.invokeAsAssistant({
        command: "knowledge.create_note",
        input: { title: "From the assistant", body_text: "hello" },
      })
    );
    expect(created.status).toBe("executed");
    const assistant = plane.listAgents().find((a) => a.name === "Assistant");
    expect(assistant?.answers).toStrictEqual([]);

    // Second call reuses the enrollment — no duplicate agent rows.
    const again = await asOwner(plane, () =>
      plane.invokeAsAssistant({
        command: "knowledge.create_note",
        input: { title: "Second", body_text: "again" },
      })
    );
    expect(again.status).toBe("executed");
    expect(
      plane.db.vault.prepare(`SELECT count(*) AS n FROM access_agent`).get()
    ).toMatchObject({ n: 1 });

    // Confirm-gated commands park for the assistant like any non-owner: riding
    // the owner's reach is not the same as being the owner.
    const risky = await asOwner(plane, () =>
      plane.invokeAsAssistant({
        command: "social.send_message",
        input: { message_id: "not-yet-real" },
      })
    );
    expect(risky.status).toBe("parked");
    expect(
      plane.listParked().some((p) => p.command === "social.send_message")
    ).toBe(true);

    // The credential-touching pair parks too (#308 A1): confirm holds the line
    // on exactly the fields #304 pinned.
    const credentialGrab = await asOwner(plane, () =>
      plane.invokeAsAssistant({
        command: "sync.configure_credential",
        input: {
          kind: "pull.gmail",
          label: "personal",
          cred_kind: "api_key",
          api_key: "sk-x",
          allowed_hosts: ["attacker.example"],
        },
      })
    );
    expect(credentialGrab.status).toBe("parked");
  });

  test("with no acting owner the assistant holds nothing (#928 A3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    // The containment that replaces the standing grant: a call with nobody
    // behind it is a receipted deny, not an uncapped write.
    const orphaned = await plane.invokeAsAssistant({
      command: "knowledge.create_note",
      input: { title: "Nobody asked", body_text: "x" },
    });
    expect(orphaned.status).toBe("denied");
    expect(() => plane.sqlAsAssistant("SELECT 1 AS one")).toThrow(
      /owner's surface/u
    );
  });

  test("a visitor's frame is not an owner's: the assistant cannot borrow it", async () => {
    const plane = fixture.openPlane(await tempDir());
    const borrowed = await runWithVaultContext(
      {
        vaultId: plane.boot.vaultId,
        ownerId: "some-other-party",
        ownsVault: false,
      },
      () =>
        plane.invokeAsAssistant({
          command: "knowledge.create_note",
          input: { title: "Not mine", body_text: "x" },
        })
    );
    expect(borrowed.status).toBe("denied");
  });

  /*
   * THE ALLOWANCE IS THE ASSISTANT'S ALONE. An ordinary automation runs on the
   * very same owner frame — same `onBehalfOfOwner`, same trust tier — and is
   * still capped by its own standing answer. Without this case, widening the
   * allowance to every agent passes every other suite in the tree.
   */
  test("an ordinary automation on the same owner frame is still capped (#928 A3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    plane.enrollAutomationAgent("digest");
    // The bridge captures the frame at construction, so it is built INSIDE the
    // owner's frame — otherwise the automation is denied for want of an acting
    // owner and the case proves nothing about the assistant flag.
    const outcome = await asOwner(plane, () =>
      plane.agentBridgeFor("digest")({
        op: "invoke",
        payload: {
          command: "knowledge.create_note",
          input: { title: "Uninvited", body_text: "x" },
        },
      })
    );
    expect(
      outcome.ok ? (outcome.result as { status?: string }).status : "error"
    ).toBe("denied");
  });

  /*
   * THE ALLOWANCE, AT ITS OWN LEVEL. The bridge cases above deny an ordinary
   * automation for the ordinary reason (no active grant), so they would still
   * pass if the flag were widened to every agent. This holds the clause itself:
   * the assistant flag comes from the enrolment row, and only that flag plus an
   * acting owner who owns the vault opens the door.
   */
  test("only the assistant flag rides the acting owner (#928 A3)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const base = {
      kind: "agent" as const,
      callerId: "agent-1",
      provAgentKind: "ai_agent" as const,
      partyId: plane.boot.ownerPartyId,
      mayAct: true,
    };
    const owner = { ownerId: plane.boot.ownerPartyId, mayAct: true };
    const verdicts = (
      [
        { ...base, assistant: true as const, onBehalfOfOwner: owner },
        { ...base, onBehalfOfOwner: owner },
        { ...base, assistant: true as const },
        {
          ...base,
          assistant: true as const,
          onBehalfOfOwner: { ...owner, mayAct: false },
        },
      ] as const
    ).map(
      (identity) =>
        evaluateAccess(plane.db.vault, identity, "knowledge", "note", "act")
          .decision
    );
    expect(verdicts).toStrictEqual(["allow", "deny", "deny", "deny"]);
  });

  test("whole-model sql is the owner's, held on the owner's behalf", async () => {
    const plane = fixture.openPlane(await tempDir());
    const result = await asOwner(plane, async () =>
      plane.sqlAsAssistant("SELECT count(*) AS n FROM core_party")
    );
    // Receipted either way — the exercise is the evidence (#928 AP-one-id-space).
    expect(result.receiptId).toBeTruthy();
    expect(
      plane.db.audit
        .prepare(
          `SELECT count(*) AS n FROM access_receipt WHERE object_type = 'vault.sql'`
        )
        .get()
    ).toMatchObject({ n: 1 });
  });
});
