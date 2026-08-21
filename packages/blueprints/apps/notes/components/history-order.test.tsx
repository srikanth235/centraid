// The version chain is the standing answer to the lost paragraph, so what it
// promises has to be true on screen: newest first, the live body marked as
// current and offering no restore of itself, and every earlier body one
// control away.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { NoteVersion } from "../types.ts";
import { historyStatus } from "../view-copy.ts";
import { HistoryRoute } from "./Places.tsx";

const CHAIN: readonly NoteVersion[] = [
  {
    content_id: "content-3",
    body: "the third and current body",
    current: true,
    asserted_at: "2026-08-20T09:00:00Z",
  },
  {
    content_id: "content-2",
    body: "the second body",
    current: false,
    asserted_at: "2026-08-12T09:00:00Z",
  },
  {
    content_id: "content-1",
    body: "the first body",
    current: false,
    asserted_at: "2026-03-04T09:00:00Z",
  },
];

const html = renderToStaticMarkup(
  <HistoryRoute versions={CHAIN} onRestore={() => {}} />
);

describe("the version chain", () => {
  test("rows stand in the order the chain came back, newest first", () => {
    const order = ["third and current", "second body", "first body"].map(
      (fragment) => html.indexOf(fragment)
    );
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toStrictEqual([...order].toSorted((a, b) => a - b));
  });

  test("the live body says it is current instead of offering a restore", () => {
    const currentRow = html.slice(
      html.indexOf("third and current"),
      html.indexOf("second body")
    );
    expect(currentRow).toContain("current");
    expect(currentRow).not.toContain(">Restore<");
  });

  test("every earlier body carries its own restore", () => {
    expect([...html.matchAll(/>Restore</gu)]).toHaveLength(2);
  });

  test("restoring APPENDS, and the status line says so", () => {
    expect(historyStatus(CHAIN.length)).toBe(
      "3 versions · restoring appends, it never rewrites"
    );
  });
});
