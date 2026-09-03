import { readFileSync } from "node:fs";
import path from "node:path";

import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineBandClaim } from "@centraid/blueprints/apps/inline-types";

import { BAND_CAPSULE_SIZE } from "./AppBand.js";
import { createInlineFrameChannel } from "./inlineFrame.js";
import { useInlineAppFrame } from "./routes/inlineAppFrame.js";
import ShellFrame from "./ShellFrame.js";
import { resetStatus } from "./statusChannel.js";
import StatusLine from "./StatusLine.js";
import Stem from "./Stem.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: JSX.Element): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

const app = {
  id: "photos",
  name: "Photos",
  iconKey: "Image",
  color: "#345",
} as unknown as AppMetaResolvedType;

const claim: InlineBandClaim = {
  activeId: "library",
  destinations: [
    { icon: "Image", id: "library", label: "Library" },
    { icon: "album", id: "albums", label: "Albums" },
    { icon: "person", id: "people", label: "People" },
    { icon: "Search", id: "search", label: "Search" },
  ],
  onSelect: vi.fn<InlineBandClaim["onSelect"]>(),
};

const NO_HOME = (): void => undefined;

function Host({
  compact,
  firstParty = true,
  onHome = NO_HOME,
  contribute,
}: {
  compact: boolean;
  firstParty?: boolean;
  onHome?: () => void;
  contribute: (frame: ReturnType<typeof useInlineAppFrame>["frame"]) => void;
}): JSX.Element {
  const contributed = useInlineAppFrame({
    app,
    compact,
    firstParty,
    mountKey: `${app.id}\0${app.id}:0\0vault-own`,
    onHome,
  });
  contributeOnce(contributed.frame, contribute);
  return (
    <ShellFrame
      compact={compact}
      stem={
        <Stem
          pins={{}}
          onSelect={() => undefined}
          onSearch={() => undefined}
          onAllApps={() => undefined}
          compact={compact}
        />
      }
      {...(contributed.band === undefined ? {} : { band: contributed.band })}
      appMark={contributed.mark}
      appTitle={contributed.title}
      {...(contributed.count === undefined
        ? {}
        : { appCount: contributed.count })}
      titlebarRight={
        <>
          <button type="button" aria-label="App settings" />
          {contributed.actions}
        </>
      }
      statusLine={<StatusLine ambient="Ready" />}
    >
      <div data-testid="main">MAIN</div>
    </ShellFrame>
  );
}

const contributed = new WeakSet<object>();
function contributeOnce(frame: object, run: (frame: never) => void): void {
  if (contributed.has(frame)) return;
  contributed.add(frame);
  run(frame as never);
}

describe("shell/inlineFrame", () => {
  beforeEach(() => {
    resetStatus();
    localStorage.clear();
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: "#111",
        boxShadow: "none",
        glyphColor: "#fff",
      }),
    };
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    resetStatus();
  });

  describe("the app bar", () => {
    it("renders the app's contributed title, count and actions in the FRAME's bar", () => {
      const el = render(
        <Host
          compact={false}
          contribute={(frame) =>
            frame.setAppBar({
              actions: <button type="button">Import</button>,
              count: "1,904",
              title: "Photos",
            })
          }
        />
      );
      const bar = el.querySelector<HTMLElement>(".appBar")!;
      expect(bar.querySelector(".appTitle")?.textContent).toBe("Photos");
      expect(bar.querySelector(".appCount")?.textContent).toBe("1,904");
      expect(bar.textContent).toContain("Import");
      expect(bar.dataset.lockup).toBe("app");
      expect(bar.querySelector('[aria-label="Back"]')).not.toBeNull();
      expect(bar.querySelector('[aria-label="App settings"]')).not.toBeNull();
    });

    it("names the app until it says otherwise, so the bar never paints blank", () => {
      const el = render(<Host compact={false} contribute={() => undefined} />);
      expect(el.querySelector(".appTitle")?.textContent).toBe("Photos");
    });
  });

  describe("the status line", () => {
    it("carries the app's note and fires its ONE inline action", () => {
      const undo = vi.fn<() => void>();
      const el = render(
        <Host
          compact={false}
          contribute={(frame) =>
            frame.setStatus("Deleted 3 photographs", {
              action: { label: "Undo", run: undo },
            })
          }
        />
      );
      expect(el.querySelectorAll(".statusLine")).toHaveLength(1);
      const action = el.querySelector<HTMLButtonElement>(".statusAction")!;
      expect(action.textContent).toBe("Undo");
      act(() => action.click());
      expect(undo).toHaveBeenCalledOnce();
      expect(el.querySelectorAll(".statusAction")).toHaveLength(1);
    });
  });

  describe("the compact band", () => {
    const bands = (el: HTMLElement): NodeListOf<HTMLElement> =>
      el.querySelectorAll<HTMLElement>("[data-band]");

    it("leaves the frame's band standing when no route claims it", () => {
      const el = render(<Host compact contribute={() => undefined} />);
      expect(bands(el)).toHaveLength(1);
      expect(bands(el)[0]!.dataset.band).toBe("host");
    });

    it("replaces the frame's band when a first-party route claims it — never two", () => {
      const el = render(
        <Host compact contribute={(frame) => frame.claimBand(claim)} />
      );
      const found = bands(el);
      expect(found).toHaveLength(1);
      expect(found[0]!.dataset.band).toBe("app");
      expect(found[0]!.getAttribute("aria-label")).toBe("Photos");
      const group = found[0]!.querySelector<HTMLElement>("fieldset")!;
      expect(group.querySelectorAll("button")).toHaveLength(4);
      expect(group.querySelectorAll(".launchChip svg")).toHaveLength(4);
      expect(group.querySelector('[aria-label="Home"]')).toBeNull();
      expect(found[0]!.querySelector('button[aria-label^="Use "]')).toBeNull();
    });

    it("keeps the home capsule outside the group, at 52px and never under 44", () => {
      const home = vi.fn<() => void>();
      const el = render(
        <Host
          compact
          onHome={home}
          contribute={(frame) => frame.claimBand(claim)}
        />
      );
      const capsule = el.querySelector<HTMLElement>('[aria-label="Home"]')!;
      expect(capsule).not.toBeNull();
      expect(capsule.closest("fieldset")).toBeNull();
      expect(capsule.style.getPropertyValue("--band-capsule")).toBe("52px");
      expect(BAND_CAPSULE_SIZE).toBeGreaterThanOrEqual(44);
      act(() => capsule.click());
      expect(home).toHaveBeenCalledOnce();
    });

    it("refuses the claim on desktop, where there is no band to claim", () => {
      const el = render(
        <Host compact={false} contribute={(frame) => frame.claimBand(claim)} />
      );
      expect(bands(el)).toHaveLength(0);
      expect(el.querySelector('[aria-label="Home"]')).toBeNull();
    });

    it("refuses a claim from an app that does not ship with the frame", () => {
      const el = render(
        <Host
          compact
          firstParty={false}
          contribute={(frame) => frame.claimBand(claim)}
        />
      );
      expect(bands(el)).toHaveLength(1);
      expect(bands(el)[0]!.dataset.band).toBe("host");
    });

    it("floats on OPAQUE paper — no blur, no translucency, no shadow", () => {
      const css = readFileSync(
        path.join(import.meta.dirname, "chrome.module.css"),
        "utf8"
      );
      const rule =
        /\n\.stem\[data-compact="true"\],\n\.appBand \{(?<body>[^}]*)\}/u.exec(
          css
        )?.groups?.body;
      expect(rule, "the floating-band rule was not found").toBeTypeOf("string");
      expect(rule!).toMatch(/border-radius:\s*var\(--r-lg\)/u);
      expect(rule!).toMatch(/border:\s*1px solid var\(--line-strong\)/u);
      expect(rule!).toMatch(/margin-inline:\s*12px/u);
      expect(rule!).toMatch(/background:\s*var\(--bg-elev\)/u);
      expect(rule!).not.toMatch(/backdrop-filter|opacity|box-shadow/u);

      const appBand =
        /\n\.appBand \{\n {2}grid-area: stem;(?<body>[^}]*)\}/u.exec(css)
          ?.groups?.body;
      expect(appBand, "the claimed-band rule was not found").toBeTypeOf(
        "string"
      );
      expect(appBand!).toMatch(/min-inline-size:\s*0/u);
    });
  });

  describe(createInlineFrameChannel, () => {
    it("withdraws a contribution on null rather than needing a second verb", () => {
      const channel = createInlineFrameChannel();
      channel.frame.setAppBar({ title: "Photos" });
      channel.frame.claimBand(claim);
      expect(channel.read().appBar?.title).toBe("Photos");
      channel.frame.setAppBar(null);
      expect(channel.read().appBar).toBeNull();
      expect(channel.read().band).not.toBeNull();
    });

    it("tells the host once per change", () => {
      const channel = createInlineFrameChannel();
      const seen = vi.fn<() => void>();
      const off = channel.subscribe(seen);
      channel.frame.setAppBar({ count: "1" });
      channel.frame.setAppBar({ count: "2" });
      expect(seen).toHaveBeenCalledTimes(2);
      off();
      channel.frame.setAppBar({ count: "3" });
      expect(seen).toHaveBeenCalledTimes(2);
    });
  });
});
