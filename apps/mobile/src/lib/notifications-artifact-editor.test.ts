import { describe, expect, test } from "vitest";

import {
  applyArtifactEdits,
  editableArtifactFields,
} from "./notifications-artifact-editor";

describe("mobile Notifications artifact editing", () => {
  test("edits scalar text without changing structured fields", () => {
    const artifact = {
      subject: "Original",
      body: "First line\nSecond line",
      attendees: ["a@example.com"],
      metadata: { thread: "t-1" },
    };
    expect(editableArtifactFields(artifact)).toStrictEqual([
      {
        key: "subject",
        label: "Subject",
        value: "Original",
        multiline: false,
      },
      {
        key: "body",
        label: "Body",
        value: "First line\nSecond line",
        multiline: true,
      },
    ]);
    expect(
      applyArtifactEdits(artifact, {
        subject: "Revised",
        body: "Updated body",
      })
    ).toStrictEqual({
      subject: "Revised",
      body: "Updated body",
      attendees: ["a@example.com"],
      metadata: { thread: "t-1" },
    });
  });
});
