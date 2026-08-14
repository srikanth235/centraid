import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

// Does this kit actually DRAW every flag the shared contracts let a caller set?
//
// The contracts (`@centraid/design/blocks`) stop the two kits describing a
// block differently. They cannot stop a kit accepting `dangerous` and then
// rendering the ordinary control. This file renders the SHARED fixtures — the
// same objects the mobile kit renders in its own parity test — and asserts the
// DOM's marks appear. The phone asserts its own, because only it knows what a
// native destructive border looks like.
//
// A failure here means one seat quietly lost a distinction the other still
// makes. That is exactly how the row `hint` and the panel's forced fill went
// unnoticed until #765 wrote both halves down.
import {
  BUTTON_FIXTURE,
  CHIPS_FIXTURE,
  DISTRIBUTION_FIXTURE,
  EMPTY_ROUTINE_FIXTURE,
  GRID_COLUMNS_FIXTURE,
  GRID_ROW_FIXTURE,
  PANEL_COMMIT_FIXTURE,
  PANEL_DANGEROUS_FIXTURE,
  PANEL_FACT_NOTE_FIXTURE,
  PANEL_FACTS_FIXTURE,
  PANEL_FIGURE_FIXTURE,
  ROW_ACTION_FIXTURE,
  ROW_FIXTURE,
  ROW_PLAIN_FIXTURE,
  SECTION_ACTION_FIXTURE,
  SECTION_FIXTURE,
} from "@centraid/design/blocks";

import Button from "./Button.js";
import ChipsBlock from "./ChipsBlock.js";
import DistributionBlock from "./DistributionBlock.js";
import EmptyBlock from "./EmptyBlock.js";
import GridBlock from "./GridBlock.js";
import PanelBlock from "./PanelBlock.js";
import RowsBlock from "./RowsBlock.js";
import SectionBlock from "./SectionBlock.js";

let dispose: (() => void) | undefined;

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  dispose = () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  return host;
}

describe("block parity — the shell draws every shared flag", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("marks a row that is net, dangerous and off, all at once", () => {
    const el = render(
      <RowsBlock
        rows={[
          {
            ...ROW_FIXTURE,
            action: { ...ROW_ACTION_FIXTURE, onClick() {} },
            id: "r",
          },
        ]}
      />
    );
    const row = el.querySelector("[data-net]");
    expect((row as HTMLElement | null)?.dataset.net).toBe("true");
    expect((row as HTMLElement | null)?.dataset.off).toBe("true");
    // `dangerous` reaches the control as the destructive recipe, and `off`
    // disables it — on the leaf, never as a container opacity.
    const verb = el.querySelector("button") as HTMLButtonElement;
    expect(verb.className).toContain("destructive");
    expect(verb.disabled).toBe(true);
    // The hint is what tells ten identical verbs apart.
    expect(verb.title).toBe(ROW_ACTION_FIXTURE.hint);
  });

  it("leaves a plain row unmarked, so the marks mean something", () => {
    const el = render(<RowsBlock rows={[{ ...ROW_PLAIN_FIXTURE, id: "r" }]} />);
    const row = el.querySelector("[class*='row']");
    expect((row as HTMLElement | null)?.dataset.net).toBeUndefined();
    expect((row as HTMLElement | null)?.dataset.off).toBeUndefined();
  });

  it("tones only the value of a net fact, and only the mono one is numeric", () => {
    const el = render(<PanelBlock facts={PANEL_FACTS_FIXTURE} />);
    const values = [...el.querySelectorAll("dd")];
    expect(values[0]?.dataset.net).toBeUndefined();
    expect(values[1]?.dataset.net).toBe("true");
    expect(values[1]?.dataset.mono).toBe("true");
    // The key column carries the DISPLAYED word, not an identity.
    expect(
      [...el.querySelectorAll("dt")].map((n) => n.textContent)
    ).toStrictEqual(PANEL_FACTS_FIXTURE.map((f) => f.key));
  });

  it("fills a panel's commit and outlines a panel's destructive verb", () => {
    const commit = render(
      <PanelBlock action={{ ...PANEL_COMMIT_FIXTURE, onClick() {} }} />
    );
    expect((commit.querySelector("button") as HTMLElement).className).toContain(
      "primary"
    );
    dispose?.();
    dispose = undefined;
    const danger = render(
      <PanelBlock action={{ ...PANEL_DANGEROUS_FIXTURE, onClick() {} }} />
    );
    const verb = danger.querySelector("button") as HTMLElement;
    expect(verb.className).toContain("destructive");
    expect(verb.className).not.toContain("primary");
  });

  it("carries a fact's own caveat, and promotes the figure to the display rung", () => {
    const el = render(
      <PanelBlock
        facts={[PANEL_FACT_NOTE_FIXTURE]}
        figure={PANEL_FIGURE_FIXTURE}
      />
    );
    expect(el.querySelector(".factNote")?.textContent).toBe(
      PANEL_FACT_NOTE_FIXTURE.note
    );
    expect(el.querySelector(".figureValue")?.textContent).toBe(
      PANEL_FIGURE_FIXTURE.value
    );
    expect(el.querySelector(".figureQualifier")?.textContent).toBe(
      PANEL_FIGURE_FIXTURE.qualifier
    );
  });

  it("orders a distribution by share and draws each row's bar", () => {
    const el = render(
      <DistributionBlock
        ariaLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    expect(
      [...el.querySelectorAll("dt")].map((n) => n.textContent)
    ).toStrictEqual(["claude-code", "codex", "gemini-cli"]);
    expect(
      [...el.querySelectorAll<HTMLElement>(".track")].map((n) =>
        n.style.getPropertyValue("--dist-share")
      )
    ).toStrictEqual(["73", "26", "1"]);
  });

  it("states a chip's on-ness without spending colour on it", () => {
    const el = render(
      <ChipsBlock ariaLabel="Filter" chips={CHIPS_FIXTURE} onPick={() => {}} />
    );
    const chips = [...el.querySelectorAll("button")];
    expect(chips[0]?.ariaPressed).toBe("true");
    expect(chips[1]?.ariaPressed).toBe("false");
  });

  it("draws the routine empty state quieter than a first meeting", () => {
    const el = render(<EmptyBlock {...EMPTY_ROUTINE_FIXTURE} />);
    expect(
      el.querySelector<HTMLElement>("[data-routine]")?.dataset.routine
    ).toBe("true");
    expect(el.querySelector("h2")?.textContent).toBe(
      EMPTY_ROUTINE_FIXTURE.title
    );
  });

  it("names a section and its count", () => {
    const el = render(<SectionBlock {...SECTION_FIXTURE} />);
    expect(el.querySelector("h2")?.textContent).toBe(SECTION_FIXTURE.label);
    expect(el.textContent).toContain(SECTION_FIXTURE.meta);
  });

  it("draws a section's trailing verb quiet, and inert when it is off", () => {
    const el = render(
      <SectionBlock
        {...SECTION_FIXTURE}
        action={{ ...SECTION_ACTION_FIXTURE, onClick() {} }}
      />
    );
    const verb = el.querySelector("button") as HTMLButtonElement;
    expect(verb.textContent).toContain(SECTION_ACTION_FIXTURE.label);
    expect(verb.className).toContain("quiet");
    expect(verb.className).not.toContain("primary");
    expect(verb.disabled).toBe(true);
    expect(verb.title).toBe(SECTION_ACTION_FIXTURE.hint);
  });

  it("declares every grid column and keeps its four cell kinds apart", () => {
    const el = render(
      <GridBlock
        ariaLabel="Records"
        columns={GRID_COLUMNS_FIXTURE}
        onSort={() => {}}
        rows={[{ id: "p-1", name: "Thomasina", values: GRID_ROW_FIXTURE }]}
      />
    );
    // The declarations: badges on the header, and no sort control on the one
    // column the store cannot order by.
    expect(el.querySelector('th[data-col="party_id"]')?.textContent).toContain(
      "pk"
    );
    expect(
      el.querySelector('th[data-col="home_place_id"]')?.textContent
    ).toContain("fk");
    expect(el.querySelector('th[data-col="extra"] button')).toBeNull();

    // The four cell kinds. A value, a value cut reversibly, an absence, an
    // empty string, and a value the store will not print.
    expect(el.querySelector('td[data-col="party_id"]')?.textContent).toBe(
      "p-1"
    );
    expect(
      el.querySelector('td[data-col="display_name"] button')?.textContent
    ).toContain("…");
    expect(
      el.querySelector<HTMLElement>(
        'td[data-col="home_place_id"] [data-absent]'
      )?.dataset.absent
    ).toBe("null");
    expect(
      el.querySelector<HTMLElement>('td[data-col="extra"] [data-absent]')
        ?.dataset.absent
    ).toBe("blank");
    expect(el.textContent).not.toContain("«sealed»");
    expect(el.querySelector('td[data-col="secret"]')?.textContent).toContain(
      "sealed"
    );

    // The register is per COLUMN, so one grid holds prose and figures at once.
    expect(
      el.querySelector<HTMLElement>('td[data-col="party_id"]')?.dataset.register
    ).toBe("mono");
    expect(
      el.querySelector<HTMLElement>('td[data-col="display_name"]')?.dataset
        .register
    ).toBe("text");
  });

  it("disables a button and still draws its icon", () => {
    const el = render(<Button {...BUTTON_FIXTURE} onClick={() => {}} />);
    const button = el.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(BUTTON_FIXTURE.label);
    expect(el.querySelector("svg")).not.toBeNull();
  });
});
