import { describe, expect, it, vi } from "vitest";

import type * as GatewayClient from "../../../gateway-client.js";
import type * as HarnessData from "../routes/settingsHarnessesData.js";
import {
  companionAttachmentFor,
  companionAttachmentRefs,
  companionFileAttachment,
  companionLinkAttachment,
  companionPrompt,
  companionSelectionKey,
  persistCompanionSelection,
  readCompanionSelection,
} from "./AssistantCompanionController.js";

vi.mock(import("../../../gateway-client.js"), () => ({
  ASSISTANT_APP_ID: "_assistant" as const,
  createConversation: vi.fn<typeof GatewayClient.createConversation>(),
  streamAssistantTurn: vi.fn<typeof GatewayClient.streamAssistantTurn>(),
  uploadConversationAttachment:
    vi.fn<typeof GatewayClient.uploadConversationAttachment>(),
}));
vi.mock(import("../routes/settingsHarnessesData.js"), () => ({
  loadHarnesses: vi.fn<typeof HarnessData.loadHarnesses>(),
}));

describe("AssistantCompanionController prompt composition", () => {
  it("makes a selected page attachment materially part of the submitted turn", () => {
    expect(
      companionPrompt(
        {
          attachmentIds: ["current-page"],
          includeContext: false,
          text: "Summarize the risks",
        },
        [
          {
            id: "current-page",
            label: "This page · Activity",
            source: "page",
            text: "Two approvals are waiting. Backup is current.",
          },
        ],
        "Activity",
        "Newer live context"
      )
    ).toBe(
      "Attached source: This page as text — Activity\nTwo approvals are waiting. Backup is current.\n\nSummarize the risks"
    );
  });

  it("includes only attachment chips present in the submitted request", () => {
    expect(
      companionPrompt(
        {
          attachmentIds: [],
          includeContext: true,
          text: "What changed?",
        },
        [
          {
            id: "current-page",
            label: "This page · System",
            source: "page",
          },
        ],
        "System",
        "Components healthy. No outages."
      )
    ).toBe(
      "Current page: System\nComponents healthy. No outages.\n\nWhat changed?"
    );
  });

  it("reuses an attached page snapshot when default context is still on", () => {
    const text = "Two approvals need review.";
    const prompt = companionPrompt(
      {
        attachmentIds: ["current-page"],
        includeContext: true,
        text: "Help me prioritize",
      },
      [
        {
          id: "current-page",
          label: "This page · Activity",
          source: "page",
          text,
        },
      ],
      "Activity",
      "A newer page snapshot"
    );
    expect(prompt.match(new RegExp(text, "gu"))).toHaveLength(1);
    expect(prompt).toContain("using the current page snapshot above");
  });

  it("creates a page chip from the actual page snapshot", () => {
    expect(
      companionAttachmentFor("page", "Vault", "Recipes: 18 items")
    ).toStrictEqual({
      id: "current-page",
      label: "This page · Vault",
      source: "page",
      text: "Recipes: 18 items",
    });
  });

  it("carries actual link and chosen-file payloads into the prompt", async () => {
    const link = companionLinkAttachment("https://example.com/report?q=1")!;
    const file = await companionFileAttachment(
      "document",
      new File(["real document body"], "notes.txt", { type: "text/plain" })
    );
    const prompt = companionPrompt(
      {
        attachmentIds: [link.id, file.id],
        includeContext: false,
        text: "Compare these",
      },
      [link, file],
      "Vault",
      ""
    );
    expect(prompt).toContain("URL: https://example.com/report?q=1");
    expect(prompt).toContain("Name: notes.txt");
    expect(prompt).toContain("real document body");
    const ref = {
      hash: "sha256:notes",
      mime: "text/plain",
      sizeBytes: 18,
      filename: "notes.txt",
    };
    expect(
      companionAttachmentRefs([file.id], [{ ...file, ref }, link])
    ).toStrictEqual([ref]);
  });

  it("partitions persisted harness selection by seat", () => {
    expect(companionSelectionKey("custodian")).toBe(
      "assistant.companion.selection.custodian"
    );
    expect(companionSelectionKey("viewer")).toBe(
      "assistant.companion.selection.viewer"
    );
    persistCompanionSelection("viewer", {
      harnessId: "codex",
      modelId: "gpt-5",
      effortId: "high",
    });
    expect(readCompanionSelection("viewer")).toStrictEqual({
      harnessId: "codex",
      modelId: "gpt-5",
      effortId: "high",
    });
    expect(readCompanionSelection("custodian")).toBeUndefined();
  });
});
