// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AccessScreen } from "./components/Access.tsx";
import { LockerList } from "./components/List.tsx";
import { ReviewScreen } from "./components/Review.tsx";
import { SearchScreen } from "./components/Search.tsx";
import { TrashScreen } from "./components/Trash.tsx";
import { reviewRegister } from "./review-model.ts";
import type { LockerAccessEntry, LockerRow } from "./types.ts";

const MANY = 400;

const NOOP = (): void => undefined;

const rows: LockerRow[] = Array.from({ length: MANY }, (_, index) => ({
  item_id: `l${String(index)}`,
  type: "login",
  title: `Account ${String(index)}`,
  subtitle: "ana@example.test",
  compromised: true,
}));

const receipts: LockerAccessEntry[] = Array.from(
  { length: MANY },
  (_, index) => ({
    receipt_id: `r${String(index)}`,
    kind: "reveal",
    action: "locker.reveal",
    decision: "allow",
    item_id: `l${String(index)}`,
    occurred_at: "2026-08-27T09:41:00.000Z",
  })
);

interface WindowReport {
  slice: boolean;
  setSizes: string[];
  firstPos: string | undefined;
  spacer: boolean;
}

function windowOf(markup: string, total: number): WindowReport {
  const items = [...markup.matchAll(/<li\b[^>]*>/gu)].map((match) => match[0]);
  const drawn = items.filter((tag) => tag.includes("aria-posinset"));
  return {
    slice: drawn.length > 0 && drawn.length < total / 2,
    setSizes: [
      ...new Set(
        drawn.map(
          (tag) => /aria-setsize="(?<size>\d+)"/u.exec(tag)?.groups?.size ?? ""
        )
      ),
    ],
    firstPos: /aria-posinset="(?<at>\d+)"/u.exec(drawn[0] ?? "")?.groups?.at,
    spacer: items.some((tag) => tag.includes('aria-hidden="true"')),
  };
}

const WINDOWED: WindowReport = {
  slice: true,
  setSizes: [String(MANY)],
  firstPos: "1",
  spacer: true,
};

describe("the item window", () => {
  test("mounts a slice and states the whole set on every row", () => {
    const markup = renderToStaticMarkup(
      createElement(LockerList, {
        rows,
        windowCount: MANY,
        total: MANY,
        loaded: true,
        truncated: false,
        onOpen: NOOP,
        onCopyUsername: NOOP,
        onShowMore: NOOP,
        onImport: NOOP,
        onAdd: NOOP,
      })
    );
    expect(windowOf(markup, MANY)).toStrictEqual(WINDOWED);
  });
});

describe("the routes beyond the list", () => {
  test("search windows its answers", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchScreen, {
        query: "a",
        status: "ready",
        results: rows,
        onQuery: NOOP,
        onClear: NOOP,
        onRetry: NOOP,
        onOpen: NOOP,
      })
    );
    expect(windowOf(markup, MANY)).toStrictEqual(WINDOWED);
  });

  test("review windows the items behind a verdict", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewScreen, {
        register: reviewRegister(rows),
        windowCount: MANY,
        checkedAtClock: null,
        loaded: true,
        onShowThem: NOOP,
        onChange: NOOP,
      })
    );
    expect(windowOf(markup, MANY)).toStrictEqual(WINDOWED);
  });

  test("trash windows its rows, each still carrying its purge act", () => {
    const markup = renderToStaticMarkup(
      createElement(TrashScreen, {
        rows,
        loaded: true,
        onRestore: NOOP,
        onPurge: NOOP,
      })
    );
    expect(windowOf(markup, MANY)).toStrictEqual(WINDOWED);
    expect([...markup.matchAll(/>Purge</gu)]).toHaveLength(
      [...markup.matchAll(/aria-posinset/gu)].length
    );
  });

  test("the access history windows its receipts", () => {
    const markup = renderToStaticMarkup(
      createElement(AccessScreen, {
        entries: receipts,
        window: { window: 200, truncated: false },
        itemId: null,
        titles: new Map<string, string>(),
        offline: false,
        onNarrow: NOOP,
      })
    );
    expect(windowOf(markup, MANY)).toStrictEqual(WINDOWED);
  });
});
