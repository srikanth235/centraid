import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { SeatWatermark } from "../../replica/seat/watermark.js";
import type { WebSeatOptions } from "../../replica/seat/web-seat.js";
import { useSeatWatermark } from "./useSeatWatermark.js";

const SEAT: WebSeatOptions = {
  vaultId: "vault-1",
  dbName: "/centraid-seat-abc.sqlite3",
  remember: true,
  baseUrl: "https://gateway.test",
};

const CURRENT: SeatWatermark = {
  applied: 900,
  head: 1_204,
  behind: 304,
  deferredPending: false,
  contents: "full",
};

let mounted:
  | { root: ReturnType<typeof createRoot>; host: HTMLElement }
  | undefined;

function unmountHeld(): void {
  if (!mounted) return;
  const held = mounted;
  mounted = undefined;
  act(() => held.root.unmount());
  held.host.remove();
}

async function render(
  seat: WebSeatOptions | undefined,
  open: (options: WebSeatOptions) => Promise<{
    sync: () => Promise<SeatWatermark | undefined>;
    close: () => Promise<void>;
  }>
): Promise<HTMLElement> {
  function Probe(): JSX.Element {
    const watermark = useSeatWatermark({
      ...(seat === undefined ? {} : { seat }),
      open,
    });
    return (
      <span data-testid="line">
        {watermark ? String(watermark.behind) : "none"}
      </span>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe(useSeatWatermark, () => {
  afterEach(unmountHeld);

  it("does nothing until there is a vault to copy", async () => {
    // There is no flag any more (W4-D1); the only reason nothing opens is that
    // the browser is not paired yet. NOT "opens and discards": a seat with
    // nothing to copy must not download a file.
    const opened: WebSeatOptions[] = [];
    const host = await render(undefined, (options) => {
      opened.push(options);
      return Promise.resolve({
        sync: () => Promise.resolve(CURRENT),
        close: () => Promise.resolve(),
      });
    });
    expect(opened).toStrictEqual([]);
    expect(host.textContent).toBe("none");
  });

  it("reports the seat's distance once the file has caught up", async () => {
    const host = await render(SEAT, () =>
      Promise.resolve({
        sync: () => Promise.resolve(CURRENT),
        close: () => Promise.resolve(),
      })
    );
    expect(host.textContent).toBe("304");
  });

  it("stays quiet when the seat cannot open — an older copy is not an error", async () => {
    const host = await render(SEAT, () =>
      Promise.reject(new Error("this browser has no OPFS"))
    );
    expect(host.textContent).toBe("none");
  });

  it("closes the seat it opened when the route goes away", async () => {
    let closed = 0;
    await render(SEAT, () =>
      Promise.resolve({
        sync: () => Promise.resolve(CURRENT),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      })
    );
    unmountHeld();
    await Promise.resolve();
    expect(closed).toBe(1);
  });
});
