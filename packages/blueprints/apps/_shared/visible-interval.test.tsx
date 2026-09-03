// @vitest-environment jsdom
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { useVisibleInterval } from "./visible-interval.ts";

describe("a second hand that stops when nobody is looking", () => {
  let hidden = false;
  let host: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  function Clock({ active = true }: { active?: boolean }): ReactNode {
    const [count, setCount] = useState(0);
    useVisibleInterval(() => setCount((value) => value + 1), 1_000, active);
    return <span data-testid="count">{count}</span>;
  }

  function mount(active = true): void {
    hidden = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Clock active={active} />));
  }

  function unmount(): void {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  }

  function setVisibility(next: "visible" | "hidden"): void {
    hidden = next === "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  const shown = (): number =>
    Number(host?.querySelector('[data-testid="count"]')?.textContent ?? "");

  it("ticks once a second while the document is visible", () => {
    const clock = useFakeClock();
    mount();
    act(() => clock.advanceSync(3_000));
    expect(shown()).toBe(3);
    unmount();
  });

  it("stops entirely while hidden — no wake-ups behind another window", () => {
    const clock = useFakeClock();
    mount();
    act(() => clock.advanceSync(2_000));
    expect(shown()).toBe(2);

    setVisibility("hidden");
    act(() => clock.advanceSync(60_000));
    expect(shown()).toBe(2);
    unmount();
  });

  it("catches up ONCE on return, then resumes", () => {
    const clock = useFakeClock();
    mount();
    setVisibility("hidden");
    act(() => clock.advanceSync(60_000));
    const beforeReturn = shown();

    setVisibility("visible");
    expect(shown()).toBe(beforeReturn + 1);

    act(() => clock.advanceSync(2_000));
    expect(shown()).toBe(beforeReturn + 3);
    unmount();
  });

  it("runs nothing at all while inactive", () => {
    const clock = useFakeClock();
    mount(false);
    act(() => clock.advanceSync(10_000));
    expect(shown()).toBe(0);
    unmount();
  });

  it("clears the timer and the visibility listener on unmount", () => {
    const clock = useFakeClock();
    mount();
    act(() => clock.advanceSync(1_000));
    expect(clock.pending()).toBe(1);

    unmount();
    expect(clock.pending()).toBe(0);
    setVisibility("visible");
    expect(clock.pending()).toBe(0);
  });
});
