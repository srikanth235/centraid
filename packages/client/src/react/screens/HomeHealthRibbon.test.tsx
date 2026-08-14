import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import HomeHealthRibbon from "./HomeHealthRibbon.js";

type Open = Parameters<typeof HomeHealthRibbon>[0]["onOpen"];

describe(HomeHealthRibbon, () => {
  it("renders a healthy signal as quiet status text without a false action", () => {
    const html = renderToStaticMarkup(
      <HomeHealthRibbon
        signal={{ copy: "All safe", tone: "quiet" }}
        onOpen={vi.fn<Open>()}
      />
    );
    expect(html).toContain("<output");
    expect(html).not.toContain("<button");
  });

  it("makes the whole attention line open its one destination", () => {
    const html = renderToStaticMarkup(
      <HomeHealthRibbon
        signal={{
          action: { label: "Open System", route: { kind: "gateway" } },
          copy: "Backup overdue",
          tone: "attention",
        }}
        onOpen={vi.fn<Open>()}
      />
    );
    expect(html).toContain('data-tone="attention"');
    expect(html).toContain("Open System");
    expect(html.match(/<button/gu)).toHaveLength(1);
  });
});
