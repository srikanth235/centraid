import { describe, expect, test } from "vitest";

import { describeInvocationInput, describeScopes } from "./decision-detail";

describe(describeScopes, () => {
  test("names schema, table, verbs and extent like the web card does", () => {
    expect(
      describeScopes([
        { schema: "core", table: "party", verbs: "read" },
        {
          schema: "mail",
          table: "message",
          verbs: "read+act",
          rowFilter: [{ field: "folder" }],
          fieldMask: ["subject", "body"],
        },
      ])
    ).toBe("core.party (read), mail.message (read+act · 1 row rule, 2 fields)");
  });

  test("a whole-schema ask reads as a whole-schema ask", () => {
    expect(describeScopes([{ schema: "photos", verbs: "act" }])).toBe(
      "photos (act)"
    );
  });

  test("no scopes renders nothing rather than an empty parenthesis", () => {
    expect(describeScopes([])).toBe("");
    expect(describeScopes(undefined)).toBe("");
  });
});

describe(describeInvocationInput, () => {
  test("previews what the parked command would actually do", () => {
    expect(
      describeInvocationInput({ to: "ana@example.com", subject: "Invoice" })
    ).toBe('{"to":"ana@example.com","subject":"Invoice"}');
  });

  test("elides a long input instead of hiding it", () => {
    const preview = describeInvocationInput({ body: "x".repeat(500) });
    expect(preview).toHaveLength(221);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("an empty input adds no line", () => {
    expect(describeInvocationInput({})).toBe("");
    expect(describeInvocationInput(undefined)).toBe("");
  });

  test("an unserializable input says so rather than rendering blank", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(describeInvocationInput(cyclic)).toContain("could not be displayed");
  });
});
