// The import surface, rendered (#882) — the refusal states in particular,
// because every one of them is a place where a screen could lie.
//
// What this pins:
//
//  - offline the file control is WITHHELD and the reason stands in its place;
//    the draft shelf is not drawn at all, because there is nothing to read
//  - the three verdicts are always drawn, so a reviewer has the vocabulary
//    before the rows, and `held` says the vault won
//  - a draft that parsed nothing is a REFUSAL, not an empty review
//  - nothing publishes without the member's own tap on the publish verb
//  - a staged row that is not a Locker item says which app owns it
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { StagedRow } from "@centraid/blueprints/apps/locker/import-model";
import {
  IMPORT_CHOOSE,
  IMPORT_DISCARD,
  IMPORT_NO_DRAFTS,
  IMPORT_NO_ROWS,
  IMPORT_OFFLINE,
  IMPORT_OTHER_ENTITY,
  IMPORT_PUBLISH,
} from "@centraid/blueprints/apps/locker/route-copy";
import { IMPORT_VERDICT } from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import LockerImportView from "./LockerImportView";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

const noop = (): void => undefined;

const LOGIN: StagedRow = {
  seq: 1,
  entityType: "locker.item",
  externalId: "login:Mail:me@example.test",
  disposition: "create",
  mapping: "Title → title",
};

const FOREIGN: StagedRow = {
  seq: 2,
  entityType: "core.transaction",
  externalId: "csv:2026-08-01",
  disposition: "create",
  mapping: "Amount → amount",
};

function view(
  overrides: Partial<React.ComponentProps<typeof LockerImportView>> = {}
): React.JSX.Element {
  return (
    <LockerImportView
      batches={[
        {
          batchId: "b1",
          status: "draft",
          createdAt: "2026-08-27T09:00:00.000Z",
          summary: { create: 12 },
        },
      ]}
      busy={false}
      note=""
      offline={false}
      onChoose={noop}
      onDiscard={noop}
      onOpen={noop}
      onPublish={noop}
      openBatchId={null}
      rows={null}
      {...overrides}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

function control(container: HTMLElement, label: string): HTMLElement {
  const found = nodesOf(container, "button").find((node) =>
    (node.textContent ?? "").includes(label)
  );
  expect(found).toBeDefined();
  return found as HTMLElement;
}

describe("the import surface", () => {
  it("draws the three verdicts before any row, and says the vault wins", () => {
    const { container, unmount } = mountBlock(view());
    expect(textOf(container)).toContain(IMPORT_VERDICT.new);
    expect(textOf(container)).toContain(IMPORT_VERDICT.gapfill);
    expect(textOf(container)).toContain(IMPORT_VERDICT.held);
    expect(textOf(container)).toContain("the vault wins");
    unmount();
  });

  it("withholds the file control offline and states why in its place", () => {
    const { container, unmount } = mountBlock(view({ offline: true }));
    expect(textOf(container)).toContain(IMPORT_OFFLINE);
    expect(
      nodesOf(container, "button").some((node) =>
        (node.textContent ?? "").includes(IMPORT_CHOOSE)
      )
    ).toBe(false);
    expect(textOf(container)).not.toContain(IMPORT_NO_DRAFTS);
    unmount();
  });

  it("separates a shelf with no drafts from one that has not been read", () => {
    const unread = mountBlock(view({ batches: null }));
    expect(textOf(unread.container)).not.toContain(IMPORT_NO_DRAFTS);
    unread.unmount();

    const empty = mountBlock(view({ batches: [] }));
    expect(textOf(empty.container)).toContain(IMPORT_NO_DRAFTS);
    empty.unmount();
  });

  it("names a draft the border recognised nothing in", () => {
    const { container, unmount } = mountBlock(
      view({ openBatchId: "b1", rows: [] })
    );
    expect(textOf(container)).toContain(IMPORT_NO_ROWS);
    unmount();
  });

  it("says which app owns a staged row that is not a Locker item", () => {
    const { container, unmount } = mountBlock(
      view({ openBatchId: "b1", rows: [LOGIN, FOREIGN] })
    );
    expect(textOf(container)).toContain("login:Mail:me@example.test");
    expect(textOf(container)).toContain(IMPORT_OTHER_ENTITY);
    unmount();
  });

  it("publishes and discards only from the member's own tap", () => {
    const published: string[] = [];
    const discarded: string[] = [];
    const { container, unmount } = mountBlock(
      view({
        onDiscard: (batchId) => discarded.push(batchId),
        onPublish: (batchId) => published.push(batchId),
        openBatchId: "b1",
        rows: [LOGIN],
      })
    );
    expect(published).toStrictEqual([]);
    press(control(container, IMPORT_PUBLISH));
    expect(published).toStrictEqual(["b1"]);
    press(control(container, IMPORT_DISCARD));
    expect(discarded).toStrictEqual(["b1"]);
    unmount();
  });

  it("offers no publish verb until a draft is open for review", () => {
    const { container, unmount } = mountBlock(view());
    expect(
      nodesOf(container, "button").some((node) =>
        (node.textContent ?? "").includes(IMPORT_PUBLISH)
      )
    ).toBe(false);
    unmount();
  });

  it("prints the workflow's last word — staged, published or refused", () => {
    const { container, unmount } = mountBlock(
      view({ note: "Gateway returned HTTP 404" })
    );
    expect(textOf(container)).toContain("HTTP 404");
    unmount();
  });
});
