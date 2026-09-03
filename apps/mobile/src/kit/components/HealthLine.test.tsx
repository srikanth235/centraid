import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import { healthLineFor } from "./health-line";
import HealthLine from "./HealthLine";

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

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

describe(healthLineFor, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const copy = {
    action: "Open the failure",
    detail: "Weekly digest has failed its last 3 runs, since 4 August.",
    emptyText: "Nothing to attend to",
    errorText: "This page could not load · everything else is unaffected.",
    label: "1 automation is failing",
    loadingText: "Reading from the gateway",
  };

  it("joins the standing fact to its qualifier", () => {
    expect(healthLineFor("ready", copy).text).toBe(
      "1 automation is failing · Weekly digest has failed its last 3 runs, since 4 August."
    );
  });

  it("publishes the inline verb in ready and full only", () => {
    expect(healthLineFor("ready", copy).action).toBe("Open the failure");
    expect(healthLineFor("full", copy).action).toBe("Open the failure");
    for (const state of ["empty", "loading", "error"] as const) {
      expect(healthLineFor(state, copy).action).toBeUndefined();
    }
  });

  it("takes the caller's generic sentence for each quiet state", () => {
    expect(healthLineFor("empty", copy).text).toBe(copy.emptyText);
    expect(healthLineFor("loading", copy).text).toBe(copy.loadingText);
    expect(healthLineFor("error", copy).text).toBe(copy.errorText);
  });
});

describe(HealthLine, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("draws a neutral dot and one clamped numeric line", () => {
    const container = render(<HealthLine text="99.3% of runs succeeded" />);
    const [, dot] = nodesOf(container, "div");
    const [text] = nodesOf(container, "span");
    expect(styleOf(dot ?? null).backgroundColor).toBe(colors.textFaint);
    expect(styleOf(text ?? null).fontVariant).toStrictEqual(["tabular-nums"]);
    expect(text?.dataset.lines).toBe("1");
  });

  it("moves only the dot for the seam tone", () => {
    const container = render(
      <HealthLine text="1 request is pending" tone="seam" />
    );
    const [, dot] = nodesOf(container, "div");
    const [text] = nodesOf(container, "span");
    expect(styleOf(dot ?? null).backgroundColor).toBe(colors.seam);
    expect(styleOf(text ?? null).color).toBe(colors.textFaint);
  });

  it("declares the 44pt touch-floor minHeight on the inline verb and runs its onPress", () => {
    const calls: string[] = [];
    const container = render(
      <HealthLine
        action="Re-authorize"
        onAction={() => calls.push("go")}
        text="Gmail needs re-authorization"
      />
    );
    const [verb] = nodesOf(container, "button");
    expect(styleOf(verb ?? null).minHeight).toBe(44);
    press(verb);
    expect(calls).toStrictEqual(["go"]);
  });

  it("draws no verb when the caller published none", () => {
    const container = render(<HealthLine action="Review it" text="x" />);
    expect(nodesOf(container, "button")).toHaveLength(0);
    void noop;
  });
});
// @vitest-environment jsdom
