import { describe, expect, it, vi } from "vitest";

import { pollProviderEventSource } from "./automation-event-sources.js";
import type { PollJson, PollJsonResponse } from "./automation-event-sources.js";

const gmail = {
  connectionId: "gmail-account-1",
  kind: "pull.gmail",
  label: "Personal Gmail",
};
const github = {
  connectionId: "github-account-1",
  kind: "pull.github",
  label: "Work GitHub",
};

function replies(...responses: PollJsonResponse[]): PollJson {
  return vi.fn<PollJson>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected provider request");
    return response;
  });
}

describe("pollProviderEventSource errors", () => {
  it("surfaces provider baseline, cursor, and pagination failures explicitly", async () => {
    await expect(
      pollProviderEventSource({
        trigger: {
          kind: "event",
          connectorKind: "pull.gmail",
          event: "new-message",
        },
        connection: gmail,
        now: new Date("2026-07-25T00:00:00Z"),
        limit: 50,
        pollJson: replies({ status: 503, headers: {}, body: {} }),
      })
    ).rejects.toThrow("Gmail profile baseline failed (503)");
    await expect(
      pollProviderEventSource({
        trigger: {
          kind: "event",
          connectorKind: "pull.gmail",
          event: "new-message",
        },
        connection: gmail,
        cursor: { provider: "gmail", historyId: "1" },
        now: new Date("2026-07-25T00:00:00Z"),
        limit: 50,
        pollJson: replies(
          { status: 404, headers: {}, body: {} },
          { status: 200, headers: {}, body: {} }
        ),
      })
    ).rejects.toThrow("Gmail expired-cursor rebaseline failed (200)");
    await expect(
      pollProviderEventSource({
        trigger: {
          kind: "event",
          connectorKind: "pull.gmail",
          event: "new-message",
        },
        connection: gmail,
        cursor: { provider: "gmail", historyId: "1" },
        now: new Date("2026-07-25T00:00:00Z"),
        limit: 50,
        pollJson: replies({ status: 429, headers: {}, body: {} }),
      })
    ).rejects.toThrow("Gmail history poll failed (429)");

    const githubInput = {
      trigger: {
        kind: "event" as const,
        connectorKind: "pull.github",
        event: "issue",
        filter: { repo: "acme/app" },
      },
      connection: github,
      cursor: { provider: "github", etag: '"old"' },
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 50,
    };
    await expect(
      pollProviderEventSource({
        ...githubInput,
        pollJson: replies({ status: 500, headers: {}, body: {} }),
      })
    ).rejects.toThrow("GitHub events poll failed (500)");
    await expect(
      pollProviderEventSource({
        ...githubInput,
        pollJson: replies({
          status: 200,
          headers: {
            link: '<https://evil.example/events?page=2>; rel="next"',
          },
          body: [],
        }),
      })
    ).rejects.toThrow("unsafe next URL");
    await expect(
      pollProviderEventSource({
        ...githubInput,
        pollJson: replies(
          {
            status: 200,
            headers: {
              link: "<https://api.github.com/repos/acme/app/events?page=2>; rel=next",
            },
            body: [],
          },
          { status: 502, headers: {}, body: {} }
        ),
      })
    ).rejects.toThrow("GitHub events pagination failed (502)");
  });
});
