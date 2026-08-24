// @vitest-environment jsdom
// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
// THE EDITOR IS A DECISION SURFACE, AND NOTHING IS WRITTEN UNTIL SAVE
// (v4 handoff §7.4, proto 4627). This file is the regression net for the one
// bug that makes that sentence false:
//
//   Arrow keys stepping the viewer whenever the lightbox is open. The editor
//   is mounted per asset (`key={asset.asset_id}` in Lightbox.tsx), so a stray
//   ← or → during an edit remounts it and silently throws away the member's
//   crop and rotation — with no prompt, and with nothing written anywhere to
//   get back to.
//
// So the assertions are, in order:
//
//   1. `viewerKeyAction` — the pure rule. While editing, ←/→ mean NOTHING and
//      Escape means CANCEL THE EDIT, not close the viewer.
//   2. The live editor, driven in jsdom: rotate, then send the key through the
//      same routing the orchestrator uses, and the rotation is still there.
//   3. The counter-proof, so #2 cannot pass vacuously: calling `step()` DOES
//      destroy the edit. That is exactly the call the guard is there to
//      prevent, and it is why the guard cannot live inside the editor.
//
// Also pinned here, because they are the same render: the tool row is BUTTONS
// (`Crop`, `Straighten −1°`), the ratio reads `3 : 2` with spaces, and the
// commit row is Cancel THEN Save inside the same wrapping bar (proto 4617-4630,
// 2891-2906).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// React 19 wants this global before `act()` drives a client root.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A 1×1 PNG: `isRenderableUri` must say yes, or the viewer refuses to open the
// editor at all. It never actually decodes — jsdom fires no `load`.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ASSETS = [
  { asset_id: "a1", scope_id: "", title: "First", content_uri: PNG },
  { asset_id: "a2", scope_id: "", title: "Second", content_uri: PNG },
];

// See photos-faces.test.ts on why the specifier is a PARAMETER: a literal
// inside `import()` is resolved and typechecked by tsc, which would pull
// `apps/` into this package's src-rooted program (TS6059).
const load = (relativePath: string) => import(relativePath);

function mountHost(): HTMLElement {
  document.body.innerHTML = '<div id="lightbox" hidden></div>';
  return document.querySelector("#lightbox");
}

/** The whole viewer, wired the way app-root wires it. */
async function openViewer() {
  const host = mountHost();
  const { createLightbox, viewerKeyAction } = await load(
    "../apps/photos/lightbox.tsx"
  );
  // The COMPOSITE key (asset-key.ts) — the same identity the orchestrator
  // hands the lightbox. A bare `asset_id` is not a key on a merged timeline.
  const { assetKey } = await load("../apps/photos/asset-key.ts");
  const root = createRoot(host);
  const lightbox = createLightbox({
    lightboxRoot: { render: (node) => root.render(node) },
    findAsset: (key) => ASSETS.find((a) => assetKey(a) === key),
    visibleAssets: () => ASSETS,
    getAlbums: () => [],
    getPlaces: () => [],
    refresh: async () => {},
    slideshow: { openSlideshow: () => {} },
  });
  await act(async () => {
    lightbox.openLightbox(assetKey(ASSETS[0]));
  });
  return { host, lightbox, viewerKeyAction };
}

/** Press a key the way the orchestrator routes it (app-root's `onKeydown`). */
async function press(lightbox, viewerKeyAction, key: string): Promise<void> {
  await act(async () => {
    switch (viewerKeyAction(key, lightbox.isEditing())) {
      case "cancel-edit":
        lightbox.cancelEdit();
        break;
      case "close":
        lightbox.closeLightbox();
        break;
      case "step-prev":
        lightbox.step(-1);
        break;
      case "step-next":
        lightbox.step(1);
        break;
      default:
        break;
    }
  });
}

const button = (host: HTMLElement, name: string): HTMLButtonElement =>
  [...host.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent.trim() === name
  );

/** Enter the editor and turn the frame 90°, so there is a decision to lose. */
async function startEditing(host: HTMLElement) {
  await act(async () => {
    button(host, "Edit").click();
  });
  await act(async () => {
    button(host, "Rotate 90°").click();
  });
}

describe("viewerKeyAction — what a key means over an open viewer", () => {
  let viewerKeyAction;
  beforeEach(async () => {
    ({ viewerKeyAction } = await load("../apps/photos/lightbox.tsx"));
  });

  it("steps and closes while the viewer is showing a photograph", () => {
    expect(viewerKeyAction("ArrowLeft", false)).toBe("step-prev");
    expect(viewerKeyAction("ArrowRight", false)).toBe("step-next");
    expect(viewerKeyAction("Escape", false)).toBe("close");
    expect(viewerKeyAction("k", false)).toBeNull();
  });

  it("refuses to step while an edit is in progress, and Escape cancels it", () => {
    expect(viewerKeyAction("ArrowLeft", true)).toBeNull();
    expect(viewerKeyAction("ArrowRight", true)).toBeNull();
    expect(viewerKeyAction("Escape", true)).toBe("cancel-edit");
  });
});

describe("an in-progress edit survives the viewer's own keys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("knows the editor is up", async () => {
    const { host, lightbox } = await openViewer();
    expect(lightbox.isEditing()).toBe(false);
    await startEditing(host);
    expect(lightbox.isEditing()).toBe(true);
  });

  it("← and → do not step the asset out from under an unsaved edit", async () => {
    const { host, lightbox, viewerKeyAction } = await openViewer();
    await startEditing(host);
    // `Reset` is enabled exactly while something is unsaved — the edit itself,
    // read off the rendered surface rather than off component internals.
    expect(button(host, "Reset").disabled).toBe(false);

    await press(lightbox, viewerKeyAction, "ArrowRight");
    await press(lightbox, viewerKeyAction, "ArrowLeft");

    expect(lightbox.isEditing()).toBe(true);
    expect(button(host, "Reset").disabled).toBe(false);
  });

  it("Escape cancels the edit and returns to the viewer, rather than closing it", async () => {
    const { host, lightbox, viewerKeyAction } = await openViewer();
    await startEditing(host);
    await press(lightbox, viewerKeyAction, "Escape");
    expect(lightbox.isEditing()).toBe(false);
    // The viewer is still open on the same photograph — Escape spent itself on
    // the innermost layer.
    expect(lightbox.isOpen()).toBe(true);
    expect(host.hidden).toBe(false);
    // A second Escape is the one that closes it.
    await press(lightbox, viewerKeyAction, "Escape");
    expect(lightbox.isOpen()).toBe(false);
  });

  // THE COUNTER-PROOF (sabotage, kept): stepping is genuinely destructive, so
  // the assertions above are not passing by accident. Remove the `editing`
  // branch from `viewerKeyAction` and the test above becomes this one.
  it("stepping WOULD destroy the edit — which is why the guard exists", async () => {
    const { host, lightbox } = await openViewer();
    await startEditing(host);
    await act(async () => {
      lightbox.step(1);
    });
    expect(button(host, "Reset").disabled).toBe(true);
  });
});

describe("the editor's tool row and commit row (§7.4)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Crop and Straighten are buttons, not labels over a gesture", async () => {
    const { host } = await openViewer();
    await act(async () => {
      button(host, "Edit").click();
    });
    expect(button(host, "Crop")).toBeTruthy();
    expect(button(host, "Crop").tagName).toBe("BUTTON");
    expect(button(host, "Straighten −1°")).toBeTruthy();
    expect(button(host, "Straighten +1°")).toBeTruthy();
    // The invented stepper is gone: no bare −/+ controls.
    const labels = [...host.querySelectorAll("button")].map((b) =>
      b.textContent.trim()
    );
    expect(labels).not.toContain("−");
    expect(labels).not.toContain("+");
  });

  it("the ratio reads `3 : 2`, with spaces", async () => {
    const { host } = await openViewer();
    await act(async () => {
      button(host, "Edit").click();
    });
    expect(button(host, "3 : 2")).toBeTruthy();
  });

  it("Cancel stands before Save, in the same bar as the tools", async () => {
    const { host } = await openViewer();
    await act(async () => {
      button(host, "Edit").click();
    });
    const bar = button(host, "Cancel").closest("div").parentElement;
    const order = [...bar.querySelectorAll("button")].map((b) =>
      b.textContent.trim()
    );
    expect(order).toContain("Crop");
    expect(order.indexOf("Cancel")).toBeLessThan(
      order.indexOf("Save as a new photograph")
    );
    expect(order.indexOf("Crop")).toBeLessThan(order.indexOf("Cancel"));
  });
});
