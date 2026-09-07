import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { SeatWatermark } from "../../replica/seat/watermark.js";
import { useSeatWatermark } from "./useSeatWatermark.js";
import type { SeatWatermarkSource } from "./useSeatWatermark.js";

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
  session: () => Promise<SeatWatermarkSource | undefined>
): Promise<HTMLElement> {
  function Probe(): JSX.Element {
    const watermark = useSeatWatermark({ session });
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

  it("says nothing while the browser has no session to ask", async () => {
    const host = await render(() => Promise.resolve(undefined));
    expect(host.textContent).toBe("none");
  });

  it("reports the seat's distance once the file has caught up", async () => {
    const host = await render(() =>
      Promise.resolve({ syncSeat: () => Promise.resolve(CURRENT) })
    );
    expect(host.textContent).toBe("304");
  });

  it("stays quiet when the seat cannot open — an older copy is not an error", async () => {
    const host = await render(() =>
      Promise.resolve({
        syncSeat: () => Promise.reject(new Error("this browser has no OPFS")),
      })
    );
    expect(host.textContent).toBe("none");
  });

  it("does not close the session's seat when the route goes away", async () => {
    // The seat outlives this screen: it is the SESSION's, and closing it here
    // would take the read path down with the custody line.
    let closed = 0;
    await render(() =>
      Promise.resolve({
        syncSeat: () => Promise.resolve(CURRENT),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      } as SeatWatermarkSource)
    );
    unmountHeld();
    await Promise.resolve();
    expect(closed).toBe(0);
  });
});
