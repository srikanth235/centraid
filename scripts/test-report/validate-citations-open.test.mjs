import { describe, expect, test } from "vitest";

import {
  collectCitations,
  declaredOpenIssues,
  reportCitationErrors,
  validateOpenCitations,
} from "./validate-citations-open.mjs";

/**
 * Unit tests for the open-citation gate (#864 Wave 0).
 *
 * The gate's whole value is that it CANNOT pass quietly, so the cases that
 * matter most here are the unhappy ones: a closed citation must name its
 * number, and an unreachable API must fail loudly rather than degrade into a
 * green run. Every case injects `fetch`, so the suite stays hermetic.
 */

/** A fetch double: `states` maps issue number to a GitHub issue state. */
function fakeFetch(states) {
  return async (url) => {
    const issue = Number(url.split("/").at(-1));
    if (!(issue in states))
      return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ state: states[issue] }),
    };
  };
}

const matrixWith = (issue, state) => ({
  trackingIssues: {
    [String(issue)]: {
      url: `https://github.com/srikanth235/centraid/issues/${issue}`,
      state,
    },
  },
});

describe("collectCitations", () => {
  test("collects structural trackingIssue and issue fields with their paths", () => {
    const citations = collectCitations(
      {
        gaps: { "extension.offline": { trackingIssue: 864 } },
        sites: { "a.test.ts#1": { issue: 864 } },
      },
      "tests/fixture.json"
    );
    expect([...citations.keys()]).toEqual([864]);
    expect(citations.get(864)).toEqual([
      "tests/fixture.json.gaps.extension.offline.trackingIssue",
      "tests/fixture.json.sites.a.test.ts#1.issue",
    ]);
  });

  test("collects the live-tracking prose forms but not provenance", () => {
    const citations = collectCitations(
      {
        notes: {
          a: "Partial: thin. Tracked under #864 (originally #656).",
          b: "Tracked gap (#864, originally #656): no journey.",
          c: "Remaining depth is tracked under #864.",
          d: "#535 Phase 5 introduced the note rule; originally #656.",
        },
      },
      "m"
    );
    expect([...citations.keys()]).toEqual([864]);
    expect(citations.get(864)).toHaveLength(3);
  });

  test("ignores the trackingIssues registry itself so provenance entries are not citations", () => {
    const citations = collectCitations(
      {
        trackingIssues: { 656: { state: "closed" }, 864: { state: "open" } },
      },
      "m"
    );
    expect([...citations.keys()]).toEqual([]);
  });
});

describe("declaredOpenIssues", () => {
  test("returns only the entries that claim to be open", () => {
    expect(
      declaredOpenIssues({
        trackingIssues: {
          656: { state: "closed" },
          864: { state: "open" },
          781: { state: "open" },
        },
      })
    ).toEqual([781, 864]);
  });
});

describe("validateOpenCitations", () => {
  const sources = {
    "tests/matrix.json": {
      gaps: { "extension.offline": { trackingIssue: 42 } },
    },
  };

  test("an open citation passes", async () => {
    const { errors, checked } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "open"),
      token: "t",
      fetchImpl: fakeFetch({ 42: "open" }),
    });
    expect(errors).toEqual([]);
    expect(checked).toBe(1);
  });

  test("a closed citation fails, naming the number, the site, and the remedy", async () => {
    const { errors } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "closed"),
      token: "t",
      fetchImpl: fakeFetch({ 42: "closed" }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("#42");
    expect(errors[0]).toContain(
      "tests/matrix.json.gaps.extension.offline.trackingIssue"
    );
    expect(errors[0]).toContain("re-home it to the successor umbrella");
  });

  test("a trackingIssues entry that claims open while the issue is closed fails", async () => {
    const { errors } = await validateOpenCitations({
      sources: {},
      matrix: matrixWith(781, "open"),
      token: "t",
      fetchImpl: fakeFetch({ 781: "closed" }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('#781 declares state "open"');
  });

  test("a transport failure is a hard failure that says the check did not run", async () => {
    const { errors } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "open"),
      token: "t",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("did NOT run");
    expect(errors[0]).toContain("ENOTFOUND");
    expect(errors[0]).not.toContain("re-home");
  });

  test("a non-200 response is unreachable, never a silent pass", async () => {
    const { errors } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "open"),
      token: "t",
      // 42 is absent from the double, so the fake returns 404.
      fetchImpl: fakeFetch({}),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 404");
    expect(errors[0]).toContain("did NOT run");
  });

  test("a missing GITHUB_TOKEN fails with instructions and never calls the API", async () => {
    let calls = 0;
    const { errors, checked } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "open"),
      token: undefined,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ state: "open" }) };
      },
    });
    expect(calls).toBe(0);
    expect(checked).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("GITHUB_TOKEN is not set");
    expect(errors[0]).toContain("secrets.GITHUB_TOKEN");
    expect(errors[0]).toContain("gh auth token");
  });

  test("an empty token string is treated as missing, not as an anonymous request", async () => {
    const { errors } = await validateOpenCitations({
      sources,
      matrix: matrixWith(42, "open"),
      token: "   ",
      fetchImpl: fakeFetch({ 42: "open" }),
    });
    expect(errors[0]).toContain("GITHUB_TOKEN is not set");
  });
});

describe("reportCitationErrors", () => {
  test("lists every stale citation, sorted, one error each", () => {
    const errors = reportCitationErrors({
      citations: new Map([
        [790, ["tests/skips.json.sites.b.issue"]],
        [781, ["tests/matrix.json.notes.web.compat"]],
        [864, ["tests/matrix.json.gaps.x.trackingIssue"]],
      ]),
      declaredOpen: [],
      states: new Map([
        [781, "closed"],
        [790, "closed"],
        [864, "open"],
      ]),
      unreachable: [],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("#781");
    expect(errors[1]).toContain("#790");
  });
});
