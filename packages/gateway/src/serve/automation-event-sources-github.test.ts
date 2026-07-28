// The GitHub events adapter: conditional (ETag / Last-Modified) cursors and
// 304 no-ops, safe `Link: rel=next` pagination, the `x-poll-interval` backoff
// (including the clamp that stops a hostile hint parking a trigger for years),
// and baselining a newly authored watcher without replay. Gmail cursors and the
// cross-provider malformed-row handling stay in automation-event-sources.test.ts;
// provider failures in automation-event-sources-errors.test.ts. Split from
// automation-event-sources.test.ts (500-line repo-hygiene cap); shared fixtures
// in automation-event-sources.test-fixtures.ts.

import { describe, expect, it, vi } from "vitest";

import {
  pollProviderEventSource,
  type PollJson,
} from "./automation-event-sources.js";
import { github, replies } from "./automation-event-sources.test-fixtures.js";

describe("pollProviderEventSource — GitHub", () => {
  it("uses GitHub conditional cursors, honors poll interval, and treats 304 as no-op", async () => {
    const firstFetch = replies({
      status: 200,
      headers: {
        etag: '"events-v2"',
        "last-modified": "Sat, 25 Jul 2026 00:00:00 GMT",
        "x-poll-interval": "90",
      },
      body: [
        {
          id: "2",
          type: "PullRequestEvent",
          created_at: "2026-07-25T00:00:02Z",
          payload: {
            action: "opened",
            pull_request: {
              number: 42,
              title: "Cursor engine",
              state: "open",
              html_url: "https://github.com/acme/app/pull/42",
              created_at: "2026-07-25T00:00:02Z",
              updated_at: "2026-07-25T00:00:02Z",
              user: { login: "octo" },
            },
          },
        },
      ],
    });
    const first = await pollProviderEventSource({
      trigger: {
        kind: "event",
        connectorKind: "pull.github",
        event: "pull-request",
        filter: { repo: "acme/app" },
      },
      connection: github,
      cursor: { provider: "github" },
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 50,
      pollJson: firstFetch,
    });
    expect(first.events[0]).toMatchObject({
      id: "github:event:2",
      payload: { repo: "acme/app", number: 42, action: "opened" },
    });
    expect(first.cursor).toMatchObject({
      provider: "github",
      etag: '"events-v2"',
      notBefore: Date.parse("2026-07-25T00:01:30Z"),
    });

    const secondFetch = vi.fn<PollJson>(async (_connection, _url, headers) => {
      expect(headers).toStrictEqual({
        "if-none-match": '"events-v2"',
        "if-modified-since": "Sat, 25 Jul 2026 00:00:00 GMT",
      });
      return { status: 304, headers: { "x-poll-interval": "60" } };
    }) satisfies PollJson;
    const second = await pollProviderEventSource({
      trigger: {
        kind: "event",
        connectorKind: "pull.github",
        event: "pull-request",
        filter: { repo: "acme/app" },
      },
      connection: github,
      cursor: first.cursor,
      now: new Date("2026-07-25T00:01:31Z"),
      limit: 50,
      pollJson: secondFetch,
    });
    expect(second.events).toStrictEqual([]);
    expect(second.cursor).toMatchObject({
      provider: "github",
      etag: '"events-v2"',
      notBefore: Date.parse("2026-07-25T00:02:31Z"),
    });
  });

  it("follows every safe GitHub events page and emits the complete oldest-first window", async () => {
    const issueEvent = (id: string, second: number) => ({
      id,
      type: "IssuesEvent",
      created_at: `2026-07-25T00:00:0${second}Z`,
      payload: {
        action: "opened",
        issue: {
          number: second,
          title: `Issue ${second}`,
          state: "open",
          html_url: `https://github.com/acme/app/issues/${second}`,
          created_at: `2026-07-25T00:00:0${second}Z`,
          user: { login: "octo" },
        },
      },
    });
    const poll = replies(
      {
        status: 200,
        headers: {
          etag: '"events-all"',
          link: '<https://api.github.com/repos/acme/app/events?per_page=1&page=2>; rel="next"',
        },
        body: [issueEvent("2", 2)],
      },
      {
        status: 200,
        headers: {},
        body: [issueEvent("1", 1)],
      }
    );
    const next = await pollProviderEventSource({
      trigger: {
        kind: "event",
        connectorKind: "pull.github",
        event: "issue",
        filter: { repo: "acme/app" },
      },
      connection: github,
      cursor: { provider: "github", etag: '"events-old"' },
      now: new Date("2026-07-25T00:01:00Z"),
      limit: 1,
      pollJson: poll,
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.mocked(poll).mock.calls[1]![1]).toContain("page=2");
    expect(vi.mocked(poll).mock.calls[1]![2]).toBeUndefined();
    expect(next.events.map((event) => event.id)).toStrictEqual([
      "github:event:1",
      "github:event:2",
    ]);
    expect(next.cursor).toMatchObject({
      provider: "github",
      etag: '"events-all"',
    });
  });

  it("honors GitHub backoff and baselines a newly authored watcher without replay", async () => {
    const trigger = {
      kind: "event" as const,
      connectorKind: "pull.github",
      event: "issue",
      filter: { repo: "acme/app" },
    };
    const waitingFetch = vi.fn<PollJson>();
    const waiting = await pollProviderEventSource({
      trigger,
      connection: github,
      cursor: {
        provider: "github",
        etag: '"old"',
        notBefore: Date.parse("2026-07-25T00:01:00Z"),
      },
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 50,
      pollJson: waitingFetch,
    });
    expect(waiting.events).toStrictEqual([]);
    expect(waitingFetch).not.toHaveBeenCalled();

    const baseline = await pollProviderEventSource({
      trigger,
      connection: github,
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 0,
      pollJson: replies({
        status: 200,
        headers: { etag: '"current"', "x-poll-interval": "invalid" },
        body: [
          { id: "historical", type: "IssuesEvent", payload: { issue: {} } },
        ],
      }),
    });
    expect(baseline.events).toStrictEqual([]);
    expect(baseline.cursor).toMatchObject({
      provider: "github",
      etag: '"current"',
      notBefore: Date.parse("2026-07-25T00:01:00Z"),
    });
  });

  it("clamps a provider-controlled poll interval so a trigger cannot be parked for years", async () => {
    const trigger = {
      kind: "event" as const,
      connectorKind: "pull.github" as const,
      event: "issue" as const,
      filter: { repo: "acme/app" },
    };
    // An unbounded `x-poll-interval` (hostile response, or a proxy inside
    // `allowed_hosts`) previously parked the trigger for ~3 years with no
    // health signal (issue #541 review). Clamp is 15 minutes.
    const parked = await pollProviderEventSource({
      trigger,
      connection: github,
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 50,
      pollJson: replies({
        status: 200,
        headers: { etag: '"v1"', "x-poll-interval": "100000000" },
        body: [],
      }),
    });
    expect(parked.cursor).toMatchObject({
      notBefore: Date.parse("2026-07-25T00:15:00Z"),
    });

    // A sane provider hint is still honored verbatim.
    const honored = await pollProviderEventSource({
      trigger,
      connection: github,
      now: new Date("2026-07-25T00:00:00Z"),
      limit: 50,
      pollJson: replies({
        status: 200,
        headers: { etag: '"v1"', "x-poll-interval": "120" },
        body: [],
      }),
    });
    expect(honored.cursor).toMatchObject({
      notBefore: Date.parse("2026-07-25T00:02:00Z"),
    });
  });
});
