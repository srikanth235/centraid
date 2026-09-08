import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("production Assistant companion wiring", () => {
  const sheet = read("./AssistantCompanionSheet.tsx");
  // The lockup — and with it the New chat entry — moved out of the springboard
  // when every app gained a header (`VaultBar`). One provider owns the route
  // now, which is the thing this test actually cares about.
  const home = read("../../screens/Home.tsx");
  const chrome = read("../../screens/home/VaultChrome.tsx");
  const app = read("../../../App.tsx");

  it("routes every existing app-bar New chat entry to the global companion", () => {
    // Exactly one place routes New chat, product-wide.
    expect(chrome).toContain(
      'openNewChat: () => navigation.navigate("Assistant")'
    );
    expect([...home.matchAll(/onNewChat=\{[^}]+\}/gu)]).toStrictEqual([]);
    expect(app).toMatch(
      /name="Assistant"[\s\S]*component=\{AssistantScreen\}[\s\S]*presentation: "transparentModal"/u
    );
    expect(chrome).not.toContain('navigate("AssistantFull")');
  });

  it("uses removable previous-page context in the real sent turn", () => {
    expect(sheet).toContain("state.routes[state.index - 1]?.name");
    expect(sheet).toContain("setPageContext(undefined)");
    expect(sheet).toContain("assistant.send(text, pageContext)");
  });

  it("keeps uploads and all three persisted selectors inside the sheet", () => {
    expect(sheet).toContain("assistant.attach()");
    expect(sheet).toContain("assistant.removeAttachment(attachment.hash)");
    expect(sheet).toContain("assistant.selectHarness");
    expect(sheet).toContain("assistant.selectModel");
    expect(sheet).toContain("assistant.selectEffort");
  });

  it("renders the consequence foot and tokenized sheet/control dimensions", () => {
    expect(sheet).toContain("companionConsequence(");
    expect(sheet).toContain("available: selectedHarness.sessionReady");
    expect(sheet).toContain("kind: selectedHarness.kind");
    expect(sheet).toContain("label: selectedHarness.label");
    expect(sheet).toContain("height: ASSISTANT_COMPANION_HEIGHT");
    expect(sheet).toContain("minHeight: ASSISTANT_COMPANION_TOUCH_TARGET");
    expect(sheet).toContain("width: ASSISTANT_COMPANION_TOUCH_TARGET");
  });
});
