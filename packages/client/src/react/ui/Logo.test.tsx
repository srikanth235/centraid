import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Logo from "./Logo.js";

describe(Logo, () => {
  it("draws the teal orbit mark at the given size", () => {
    const html = renderToStaticMarkup(<Logo size={48} />);
    expect(html).toContain('viewBox="0 0 240 240"');
    expect(html).toContain('width="48"');
    expect(html).toContain("<circle");
    expect(html).toContain('fill="#3EC8B4"');
    expect(html.match(/<circle/gu)?.length).toBe(5);
  });

  it("defaults to size 32", () => {
    expect(renderToStaticMarkup(<Logo />)).toContain('width="32"');
  });
});
