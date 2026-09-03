import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AutomationCompileArtifacts from "./AutomationCompileArtifacts.js";
import type { AutomationCompileArtifactsProps } from "./AutomationCompileArtifacts.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("screens/AutomationCompileArtifacts", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function mount(
    source: { manifest: string | null; handler: string | null } | null,
    file: "handler" | "manifest" = "handler",
    onFile: (f: "handler" | "manifest") => void = vi.fn<
      AutomationCompileArtifactsProps["onFile"]
    >()
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <AutomationCompileArtifacts
          source={source}
          file={file}
          onFile={onFile}
        />
      );
    });
    return container;
  }

  function tab(el: HTMLElement, name: string): HTMLButtonElement {
    const found = [
      ...el.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((b) => b.textContent === name);
    if (!found) throw new Error(`no tab "${name}"`);
    return found;
  }

  describe(AutomationCompileArtifacts, () => {
    it("renders the selected file with one gutter-numbered row per line", async () => {
      const el = await mount({
        handler: "const a = 1;\nexport default a;",
        manifest: "{}",
      });
      const code = el.querySelector('[data-testid="compile-artifact"]');
      expect(code?.textContent).toContain("const a = 1;");
      expect(code?.textContent).toContain("export default a;");
      expect(code?.textContent).toContain("1");
      expect(code?.textContent).toContain("2");
    });

    it("shows the manifest when the manifest tab is the selected file", async () => {
      const el = await mount(
        { handler: "HANDLER", manifest: "MANIFEST" },
        "manifest"
      );
      expect(
        el.querySelector('[data-testid="compile-artifact"]')?.textContent
      ).toContain("MANIFEST");
      expect(
        el.querySelector('[data-testid="compile-artifact"]')?.textContent
      ).not.toContain("HANDLER");
      expect(tab(el, "automation.json").getAttribute("aria-selected")).toBe(
        "true"
      );
      expect(tab(el, "handler.js").getAttribute("aria-selected")).toBe("false");
    });

    it("asks the owner to switch files rather than switching on its own", async () => {
      const onFile = vi.fn<AutomationCompileArtifactsProps["onFile"]>();
      const el = await mount(
        { handler: "HANDLER", manifest: "MANIFEST" },
        "handler",
        onFile
      );
      await act(async () => {
        tab(el, "automation.json").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        );
      });
      expect(onFile).toHaveBeenCalledWith("manifest");
    });

    it("explains an uncompiled plan instead of rendering an empty code block", async () => {
      const el = await mount(null);
      expect(el.querySelector('[data-testid="compile-artifact"]')).toBeNull();
      expect(el.textContent).toContain("Nothing compiled yet");
    });

    it("disables Copy when there is nothing to copy, and copies the shown file when there is", async () => {
      const writeText = vi
        .fn<(data: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      const empty = await mount({ handler: null, manifest: null });
      const emptyCopy = [
        ...empty.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.textContent?.includes("Copy"));
      expect(emptyCopy?.disabled).toBe(true);

      act(() => root?.unmount());
      container?.remove();

      const el = await mount({ handler: "const a = 1;", manifest: "{}" });
      const copy = [...el.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.includes("Copy")
      );
      expect(copy?.disabled).toBe(false);
      await act(async () => {
        copy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(writeText).toHaveBeenCalledWith("const a = 1;");
    });

    it("offers no way to edit the compiled plan", async () => {
      const el = await mount({ handler: "const a = 1;", manifest: "{}" });
      expect(el.querySelector("input")).toBeNull();
      expect(el.querySelector("textarea")).toBeNull();
      expect(el.querySelector("form")).toBeNull();
      expect(el.querySelector('[contenteditable="true"]')).toBeNull();
    });
  });
});
