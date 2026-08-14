import { afterEach, describe, expect, it } from "vitest";

import { readAssistantPageText } from "./assistantPageContext.js";

describe(readAssistantPageText, () => {
  afterEach(() => document.body.replaceChildren());

  it("captures rendered page data while excluding frame and companion chrome", () => {
    document.body.innerHTML = `
      <main data-assistant-main="true">
        <header data-assistant-chrome="true">Activity</header>
        <section><h1>Pending approvals</h1><p>Two requests need review.</p></section>
        <dialog open>Assistant conversation</dialog>
      </main>`;
    expect(readAssistantPageText()).toBe(
      "Pending approvals\nTwo requests need review."
    );
  });

  it("prefers an explicit full-bleed stage", () => {
    document.body.innerHTML = `
      <div data-assistant-page="true"><h1>Recipe board</h1><p>18 items</p></div>
      <main data-assistant-main="true"><p>Outside stage</p></main>`;
    expect(readAssistantPageText()).toBe("Recipe board\n18 items");
  });
});
