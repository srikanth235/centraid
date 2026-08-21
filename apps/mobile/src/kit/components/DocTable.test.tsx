// The record table is ALWAYS collapsed on this surface (#765, spec §9/§11):
// no column header, no Kind column, no Written column — one annotation line
// under the title carrying both, and a 52pt row to hold it. The trailing
// control is a 44×44 overflow button, and the delete item sits in its own
// group so the rule above it is the separation the reference draws.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import { snipLine } from "./doc-table-model";
import type { DocRecord, DocRowAction } from "./doc-table-model";
import DocTable from "./DocTable";

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

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const copy = {
  copyId: "Copy the id",
  delete: "Delete",
  edit: "Edit",
  more: (title: string) => `More for ${title}`,
  open: "Open the record",
};

const records: readonly DocRecord[] = [
  {
    key: "1",
    kind: "pdf",
    title: "Lease — 14 Sitwell Road.pdf",
    written: "12 Aug 2026",
  },
  {
    key: "2",
    kind: "word",
    title: "Deed of grant.docx",
    written: "8 Aug 2026",
  },
];

describe(snipLine, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("joins the two hidden columns", () => {
    expect(snipLine(records[0] as DocRecord)).toBe("pdf · 12 Aug 2026");
  });

  it("never leaves a stray separator when a store reports one half", () => {
    expect(snipLine({ key: "x", kind: "", title: "t", written: "now" })).toBe(
      "now"
    );
    expect(snipLine({ key: "x", kind: "pdf", title: "t", written: "" })).toBe(
      "pdf"
    );
    expect(snipLine({ key: "x", kind: "", title: "t", written: "" })).toBe("");
  });
});

describe(DocTable, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const noop = (): void => undefined;

  it("draws a title over one snip line, in a 52pt row", () => {
    const container = render(
      <DocTable copy={copy} onRowAction={noop} records={records} />
    );
    const [title, snip] = nodesOf(container, "span");
    expect(title?.textContent).toBe("Lease — 14 Sitwell Road.pdf");
    expect(title?.dataset.lines).toBe("1");
    expect(snip?.textContent).toBe("pdf · 12 Aug 2026");
    const [, row] = nodesOf(container, "div");
    expect(styleOf(row ?? null).minHeight).toBe(52);
  });

  it("gives each row a 44×44 overflow control that names its record", () => {
    const container = render(
      <DocTable copy={copy} onRowAction={noop} records={records} />
    );
    const buttons = nodesOf(container, "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe(
      "More for Lease — 14 Sitwell Road.pdf"
    );
    const style = styleOf(buttons[0] ?? null);
    expect(style.height).toBe(44);
    expect(style.width).toBe(44);
  });

  it("opens a menu whose delete is separated, and reports the record acted on", () => {
    const calls: [string, DocRowAction][] = [];
    const container = render(
      <DocTable
        copy={copy}
        onRowAction={(record, action) => calls.push([record.key, action])}
        records={records}
      />
    );
    press(nodesOf(container, "button")[1]);
    const labels = nodesOf(container, "button")
      .map((node) => node.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
    expect(labels).toContain("Open the record");
    expect(labels).toContain("Delete");
    const deleteItem = nodesOf(container, "button").find(
      (node) => node.getAttribute("aria-label") === "Delete"
    );
    press(deleteItem);
    expect(calls).toStrictEqual([["2", "delete"]]);
  });

  it("renders the caption under its own rule, and only when given one", () => {
    const withCaption = render(
      <DocTable
        caption="The first 6 of 1,908, newest first."
        copy={copy}
        onRowAction={noop}
        records={records}
      />
    );
    expect(nodesOf(withCaption, "span").at(-1)?.textContent).toBe(
      "The first 6 of 1,908, newest first."
    );
    dispose?.();
    dispose = undefined;
    const without = render(
      <DocTable copy={copy} onRowAction={noop} records={records} />
    );
    expect(nodesOf(without, "span")).toHaveLength(4);
  });
});
