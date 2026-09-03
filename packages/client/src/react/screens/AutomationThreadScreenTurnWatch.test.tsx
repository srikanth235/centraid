import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import type { AutomationThreadBridgeProps } from "../screen-contracts.js";
import {
  installThreadHarness,
  makeData,
  makeProps,
  mount,
  newestFirst,
} from "./AutomationThreadScreen.test-fixtures.js";

installThreadHarness();

describe("AutomationThreadScreen — live turn watch", () => {
  it("rejoins a dropped turn stream instead of spinning forever, then gives up with a retry", async () => {
    const clock = useFakeClock();
    const watchTurn = vi
      .fn<AutomationThreadBridgeProps["watchTurn"]>()
      .mockRejectedValue(new Error("HTTP 503"));
    const props = makeProps({ watchTurn }, newestFirst());
    const el = await mount(props);
    expect(watchTurn).toHaveBeenCalledOnce();
    expect(watchTurn.mock.calls[0]?.[0]).toBe("r3");

    await forEachSequentially([500, 1500, 4000, 10_000], async (delay) => {
      await act(async () => {
        await clock.advance(delay);
      });
    });
    expect(watchTurn).toHaveBeenCalledTimes(5);

    await act(async () => {
      await clock.advance(60_000);
    });
    expect(watchTurn).toHaveBeenCalledTimes(5);
    const lost = el.querySelector<HTMLElement>(
      '[data-testid="turn-watch-lost"]'
    );
    expect(lost?.textContent).toContain("Lost the live connection");

    const rejoin = el.querySelector<HTMLButtonElement>(
      '[data-testid="rejoin-turn"]'
    );
    await act(async () =>
      rejoin?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(watchTurn).toHaveBeenCalledTimes(6);
  });

  it("stops rejoining as soon as the ledger says the turn settled", async () => {
    const clock = useFakeClock();
    const watchTurn = vi
      .fn<AutomationThreadBridgeProps["watchTurn"]>()
      .mockRejectedValueOnce(new Error("stream closed"))
      .mockResolvedValue(true);
    const el = await mount(makeProps({ watchTurn }, newestFirst()));
    await act(async () => {
      await clock.advance(500);
    });
    expect(watchTurn).toHaveBeenCalledTimes(2);
    await act(async () => {
      await clock.advance(60_000);
    });
    expect(watchTurn).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="turn-watch-lost"]')).toBeNull();
  });

  it("re-reads nothing extra once a watch settles — the watcher owns that read", async () => {
    const watchTurn = vi
      .fn<AutomationThreadBridgeProps["watchTurn"]>()
      .mockResolvedValue(true);
    const props = makeProps({ watchTurn }, newestFirst());
    await mount(props);
    const colds = (
      props.loadTurnTrace as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([turnId]) => turnId === "r3");
    expect(colds).toHaveLength(1);
  });

  it("offers a retry when a cold trace read fails instead of faking an empty turn", async () => {
    const loadTurnTrace = vi
      .fn<AutomationThreadBridgeProps["loadTurnTrace"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([
        {
          kind: "ai" as const,
          streaming: false as const,
          html: "late",
          error: false,
          copyText: "late",
          feedback: null,
        },
      ]);
    const data = makeData();
    data.runs = data.runs.filter((r) => r.status !== "running");
    const el = await mount(makeProps({ loadTurnTrace }, data));

    const notice = el.querySelector<HTMLElement>(
      '[data-testid="turn-trace-error"]'
    );
    expect(notice?.textContent).toContain(
      "Couldn’t load this turn’s transcript."
    );
    expect(el.textContent).not.toContain("Working through your instructions");
    expect(el.querySelector('[data-testid="show-trace"]')).toBeTruthy();

    const retry = el.querySelector<HTMLButtonElement>(
      '[data-testid="retry-trace"]'
    );
    await act(async () =>
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(loadTurnTrace).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="turn-trace-error"]')).toBeNull();
    expect(el.textContent).toContain("late");
  });
});
