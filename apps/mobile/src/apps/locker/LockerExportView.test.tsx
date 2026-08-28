// The export surface, rendered (#882) — and the confirmation path in
// particular, because it is the one thing between a tap and every secret in the
// vault sitting in a file.
//
// What this pins:
//
//  - the consequence is stated ABOVE every control, and the confirm NAMES it
//    rather than asking whether the member is sure
//  - the commit control never runs the export: it opens the gate, and only the
//    gate's own verb writes
//  - the two options that make the file worse are off unless asked for
//  - offline the control is WITHHELD and the reason stands in its place — never
//    a grey button

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  EXPORT_COMMIT,
  EXPORT_CONFIRM_LABEL,
  EXPORT_CONFIRM_TITLE,
  EXPORT_OFFLINE,
  EXPORT_OPTIONS_NOTE,
} from "@centraid/blueprints/apps/locker/route-copy";
import { EXPORT_LEDE } from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import LockerExportView from "./LockerExportView";

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

interface ExportOptions {
  history: boolean;
  trashed: boolean;
}

/** Driven as its screen drives it, so a press is judged by what is DRAWN. */
function Seat({
  offline = false,
  onRun,
}: {
  offline?: boolean;
  onRun?: (options: ExportOptions) => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = React.useState(false);
  const [options, setOptions] = React.useState<ExportOptions>({
    history: false,
    trashed: false,
  });
  return (
    <LockerExportView
      busy={false}
      confirming={confirming}
      includeHistory={options.history}
      includeTrashed={options.trashed}
      items={42}
      offline={offline}
      onAsk={() => setConfirming(true)}
      onCancel={() => setConfirming(false)}
      onOption={(option, on) =>
        setOptions((prev) => ({ ...prev, [option]: on }))
      }
      onRun={() => onRun?.({ ...options })}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

/** The button whose visible word is `label`. */
function control(container: HTMLElement, label: string): HTMLElement {
  const found = nodesOf(container, "button").find((node) =>
    (node.textContent ?? "").includes(label)
  );
  expect(found).toBeDefined();
  return found as HTMLElement;
}

function chip(container: HTMLElement, word: string): HTMLElement {
  const chips = nodesOf(container, "button").filter((node) =>
    (node.textContent ?? "").startsWith(word)
  );
  expect(chips).toHaveLength(1);
  return chips[0] as HTMLElement;
}

describe("the export surface", () => {
  it("counts what would leave and states the consequence above the control", () => {
    const { container, unmount } = mountBlock(<Seat />);
    expect(textOf(container)).toContain("42 items");
    expect(textOf(container)).toContain(EXPORT_LEDE);
    expect(textOf(container)).toContain(EXPORT_OPTIONS_NOTE);
    unmount();
  });

  it("opens the gate rather than writing — the commit control never exports", () => {
    const runs: ExportOptions[] = [];
    const { container, unmount } = mountBlock(
      <Seat onRun={(options) => runs.push(options)} />
    );
    // Nothing that could write is on screen until the gate stands.
    expect(textOf(container)).not.toContain(EXPORT_CONFIRM_TITLE);
    press(control(container, EXPORT_COMMIT));
    expect(textOf(container)).toContain(EXPORT_CONFIRM_TITLE);
    expect(runs).toStrictEqual([]);
    unmount();
  });

  it("names the consequence in the confirm, and writes only from its own verb", () => {
    const runs: ExportOptions[] = [];
    const { container, unmount } = mountBlock(
      <Seat onRun={(options) => runs.push(options)} />
    );
    press(control(container, EXPORT_COMMIT));
    expect(textOf(container)).toContain(EXPORT_CONFIRM_TITLE);
    expect(textOf(container)).toContain(EXPORT_LEDE);
    press(control(container, EXPORT_CONFIRM_LABEL));
    expect(runs).toStrictEqual([{ history: false, trashed: false }]);
    unmount();
  });

  it("lets the gate be answered no", () => {
    const runs: ExportOptions[] = [];
    const { container, unmount } = mountBlock(
      <Seat onRun={(options) => runs.push(options)} />
    );
    press(control(container, EXPORT_COMMIT));
    press(control(container, "Cancel"));
    // The gate is struck, and the file it guarded was never made.
    expect(textOf(container)).not.toContain(EXPORT_CONFIRM_TITLE);
    expect(runs).toStrictEqual([]);
    unmount();
  });

  it("withholds the control offline and states the reason in its place", () => {
    const { container, unmount } = mountBlock(<Seat offline />);
    expect(textOf(container)).toContain(EXPORT_OFFLINE);
    expect(
      nodesOf(container, "button").some((node) =>
        (node.textContent ?? "").includes(EXPORT_COMMIT)
      )
    ).toBe(false);
    unmount();
  });

  it("leaves both file-worsening options off until they are asked for", () => {
    const runs: ExportOptions[] = [];
    const { container, unmount } = mountBlock(
      <Seat onRun={(options) => runs.push(options)} />
    );
    expect(chip(container, "Trashed").getAttribute("aria-selected")).toBe(
      "false"
    );
    press(chip(container, "Trashed"));
    expect(chip(container, "Trashed").getAttribute("aria-selected")).toBe(
      "true"
    );
    // And the option the member turned on is the one the run carries.
    press(control(container, EXPORT_COMMIT));
    press(control(container, EXPORT_CONFIRM_LABEL));
    expect(runs).toStrictEqual([{ history: false, trashed: true }]);
    unmount();
  });
});
