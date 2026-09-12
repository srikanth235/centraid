/*
 * The pure fringe of Face review (#1014, R12/R13): who a face may be named
 * as, and where a proposal actually ran. Both were answered by the screen
 * itself and both were wrong — the picker offered every enrichment agent as a
 * person, and every proposal claimed "on this device" on a seat that runs no
 * recogniser.
 */

import { describe, expect, it } from "vitest";

import { faceRunnerLabel, nameableParties } from "./face-review-model";

describe("who a face may be named as (#1014, R12)", () => {
  it("drops every party that declares a non-person kind", () => {
    // The enrichment recipes each enrol as a `core_party`, so the picker
    // offered "Face recognition", "Photo OCR", "Place names" and four more
    // beside the owner — and on a fresh library Owner was the ONLY real
    // choice it had.
    expect(
      nameableParties([
        { party_id: "owner", kind: "person", display_name: "Priya" },
        {
          party_id: "agent-faces",
          kind: "agent",
          display_name: "Face recognition",
        },
        { party_id: "agent-ocr", kind: "agent", display_name: "Photo OCR" },
        { party_id: "org", kind: "organization", display_name: "Acme" },
      ])
    ).toStrictEqual([{ partyId: "owner", name: "Priya" }]);
  });

  it("keeps a row whose kind is missing — the column is nullable and an older row is a person", () => {
    expect(
      nameableParties([{ party_id: "p1", display_name: "Ana" }])
    ).toStrictEqual([{ partyId: "p1", name: "Ana" }]);
  });

  it("labels a nameless party rather than dropping it", () => {
    expect(nameableParties([{ party_id: "p2", kind: "person" }])).toStrictEqual(
      [{ partyId: "p2", name: "Unnamed" }]
    );
  });
});

describe("where a proposal ran (#1014, R13)", () => {
  const nameOf = (id: string): string | undefined =>
    id === "agent-faces" ? "Face recognition" : undefined;

  it("names the gateway agent that produced the region", () => {
    expect(
      faceRunnerLabel(
        "r1",
        [
          {
            entity_id: "r1",
            agent_kind: "ai_agent",
            agent_id: "agent-faces",
            occurred_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        nameOf
      )
    ).toBe("Face recognition, on your gateway");
  });

  it("falls back to the recipe's home, never to this device", () => {
    // The seat runs no recogniser at all, so "on this device" was simply
    // false for every ambient proposal.
    expect(faceRunnerLabel("r1", [], nameOf)).toBe("on your gateway");
  });

  it("says this device only when the owner is the provenance agent", () => {
    expect(
      faceRunnerLabel(
        "r1",
        [
          {
            entity_id: "r1",
            agent_kind: "owner",
            agent_id: "owner",
            occurred_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        nameOf
      )
    ).toBe("on this device");
  });

  it("reads the LATEST provenance row for the region, not the first", () => {
    expect(
      faceRunnerLabel(
        "r1",
        [
          {
            entity_id: "r1",
            agent_kind: "import",
            agent_id: "takeout",
            occurred_at: "2026-09-01T00:00:00.000Z",
          },
          {
            entity_id: "r1",
            agent_kind: "ai_agent",
            agent_id: "agent-faces",
            occurred_at: "2026-09-02T00:00:00.000Z",
          },
          { entity_id: "other", agent_kind: "owner", agent_id: "owner" },
        ],
        nameOf
      )
    ).toBe("Face recognition, on your gateway");
  });
});
