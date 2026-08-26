// @vitest-environment jsdom
// THE STATES OF THE EIGHT ROUTES BEYOND THE LIST (STATES.md's Locker matrix,
// umbrella #872).
//
// `states.test.tsx` next door proves the states that are a claim about the
// WHOLE ROOM — locked, first run, denied, day one — by driving the production
// `Root`. This file proves the ones that belong to one route: the form's
// designed offline refusal, Review's two registers, Search's four states,
// Trash's countdown, and the four surfaces that describe what they cannot
// yet do.
//
// THE RULE EVERY BLOCK BELOW SHARES: a screen with no door says so and offers
// no control. A disabled button teaches a member the app is broken; a stated
// reason teaches them what it is waiting for.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { EditScreen } from "./components/Edit.tsx";
import { ReviewScreen } from "./components/Review.tsx";
import { SearchScreen } from "./components/Search.tsx";
import {
  AccessScreen,
  ExportScreen,
  FillScreen,
  ImportScreen,
} from "./components/Surfaces.tsx";
import { TrashScreen } from "./components/Trash.tsx";
import { SEALED, emptySeed } from "./draft.ts";
import { reviewRegister } from "./review-model.ts";
import {
  ACCESS_NOT_SERVED,
  ALL_CLEAR,
  CUSTOM_ROW,
  EDIT_FOOT_OFFLINE,
  EDIT_SAVE,
  EXPORT_COMMIT_NOTE,
  FILL_WHERE,
  REVIEW_ATTENTION,
  REVIEW_CHANGE_IT,
  REVIEW_UNRUNNABLE,
  SEALED_UNCHANGED,
  TRASH_EMPTY,
  TRASH_PURGE,
  TRASH_RESTORE,
} from "./route-copy.ts";
import type { LockerRow } from "./types.ts";
import {
  COMPROMISED_WHY,
  EDIT_LEDE,
  EXPORT_LEDE,
  IMPORT_VERDICT,
  NOT_OFFERED,
  PURGE_PARKED_BODY,
  SEARCH_NOTE,
  TRASH_CONFIRM_BODY,
} from "./view-copy.ts";

const ROW: LockerRow = {
  item_id: "l1",
  type: "login",
  title: "GitHub",
  subtitle: "ana@example.test",
  tags: ["work"],
};

const NOOP = (): void => undefined;

// --------------------------------------------- ADD / EDIT: the online-only rule

describe("ADD / EDIT states the online-only rule in the lede", () => {
  const form = (props: Partial<Parameters<typeof EditScreen>[0]>) =>
    renderToStaticMarkup(
      createElement(EditScreen, {
        seed: emptySeed(),
        offline: false,
        busy: false,
        error: "",
        onChange: NOOP,
        onRetype: NOOP,
        onGenerate: NOOP,
        onSave: NOOP,
        onCancel: NOOP,
        ...props,
      })
    );

  test("the rule is above the fields, not discovered at the commit", () => {
    const markup = form({});
    expect(markup).toContain(EDIT_LEDE);
    expect(markup).toContain(EDIT_SAVE);
  });

  test("OFFLINE: the commit is WITHHELD and the reason stands in its place", () => {
    const markup = form({ offline: true });
    expect(markup).toContain(EDIT_FOOT_OFFLINE);
    // Withheld, never disabled — no dead control anywhere in this app.
    expect(markup).not.toContain(`>${EDIT_SAVE}<`);
    expect(markup).not.toContain("disabled");
  });

  test("the type chip decides the fields, and it comes first", () => {
    const card = form({ seed: { ...emptySeed("card"), mode: "new" } });
    expect(card).toContain("Card number");
    expect(card).not.toContain("Username");
  });

  test("an edit shows a stored secret as a run, and says it is unchanged", () => {
    const markup = form({
      seed: {
        ...emptySeed(),
        mode: "edit",
        itemId: "l1",
        fields: { password: SEALED },
      },
    });
    expect(markup).toContain(SEALED_UNCHANGED);
    // The vault's placeholder is never drawn as if it were a value.
    expect(markup).not.toContain(SEALED);
  });

  test("the camera appears NOWHERE — it says how the seed gets here instead", () => {
    const markup = form({});
    expect(markup).not.toContain("Scan");
    expect(markup).toContain("otpauth");
  });

  test("the two structural gaps are drawn where they belong, tagged", () => {
    const markup = form({});
    expect(markup).toContain(CUSTOM_ROW);
    expect(markup).toContain("[backend-needed]");
  });
});

// ------------------------------------------------------ REVIEW: two registers

describe("REVIEW says what it checked and what it cannot check", () => {
  const review = (rows: LockerRow[], props?: { loaded?: boolean }) =>
    renderToStaticMarkup(
      createElement(ReviewScreen, {
        register: reviewRegister(rows, Date.parse("2026-01-15T00:00:00Z")),
        windowCount: rows.length,
        checkedAtClock: "09:12",
        loaded: props?.loaded ?? true,
        onShowThem: NOOP,
        onChange: NOOP,
      })
    );

  const FLAGGED: LockerRow = {
    item_id: "w1",
    type: "login",
    title: "The old forum",
    weak: true,
  };

  test("a verdict is a row with a count and a reason", () => {
    const markup = review([FLAGGED]);
    expect(markup).toContain(REVIEW_ATTENTION);
    expect(markup).toContain("Weak");
    expect(markup).toContain(REVIEW_CHANGE_IT);
  });

  test("the honest half is always drawn, with the no-producer reason", () => {
    const markup = review([FLAGGED]);
    expect(markup).toContain(REVIEW_UNRUNNABLE);
    expect(markup).toContain("Breach checking");
    expect(markup).toContain(COMPROMISED_WHY);
  });

  test("ALL CLEAR says what was checked and when, rather than nothing", () => {
    const markup = review([{ item_id: "ok", type: "login", title: "Fine" }]);
    expect(markup).toContain(ALL_CLEAR);
    expect(markup).toContain("09:12");
    // …and it still lists what could not be checked.
    expect(markup).toContain(REVIEW_UNRUNNABLE);
  });

  test("NOTHING IS EMPTY UNTIL A READ HAS LANDED", () => {
    expect(review([FLAGGED], { loaded: false })).toBe("");
  });
});

// --------------------------------------------------------------- SEARCH

describe("SEARCH says what it does not search", () => {
  const search = (props: Partial<Parameters<typeof SearchScreen>[0]>) =>
    renderToStaticMarkup(
      createElement(SearchScreen, {
        query: "",
        status: "resting" as const,
        results: null,
        onQuery: NOOP,
        onClear: NOOP,
        onRetry: NOOP,
        onOpen: NOOP,
        ...props,
      })
    );

  test("the note is the §6 sentence, and it is on the resting screen too", () => {
    expect(search({})).toContain(SEARCH_NOTE);
  });

  test("a miss echoes the query rather than claiming there is nothing", () => {
    const markup = search({ query: "git", status: "ready", results: [] });
    expect(markup).toContain("git");
  });

  test("AN UNREACHED INDEX SAYS NOTHING WAS CHECKED", () => {
    const markup = search({
      query: "git",
      status: "unreachable",
      results: null,
    });
    expect(markup).toContain("Nothing was checked");
  });

  test("results are ordinary item rows, and no secret rides the path", () => {
    const markup = search({ query: "git", status: "ready", results: [ROW] });
    expect(markup).toContain(ROW.title);
    expect(markup).toContain("matched the title");
  });
});

// ---------------------------------------------------------------- TRASH

describe("TRASH counts down, restores whole, and purges once", () => {
  const trash = (rows: LockerRow[], loaded = true) =>
    renderToStaticMarkup(
      createElement(TrashScreen, {
        rows,
        loaded,
        onRestore: NOOP,
        onPurge: NOOP,
      })
    );

  const GONE: LockerRow = {
    item_id: "z1",
    type: "login",
    title: "Old letting agent",
    purge_at: new Date(Date.now() + 22 * 86_400_000).toISOString(),
  };

  test("a row states its purge date rather than an Empty button", () => {
    const markup = trash([GONE]);
    expect(markup).toContain("purges in 22 days");
    expect(markup).toContain(TRASH_RESTORE);
    expect(markup).toContain(TRASH_PURGE);
  });

  test("empty is a sentence, and only after a read", () => {
    expect(trash([])).toContain(TRASH_EMPTY);
    expect(trash([], false)).not.toContain(TRASH_EMPTY);
  });

  test("the restore is lossless, and the confirm says the consequence", () => {
    expect(TRASH_CONFIRM_BODY).toContain("with its star and its tags");
    expect(PURGE_PARKED_BODY).toContain("parks until the owner confirms it");
  });
});

// ----------------------------------- the four surfaces drawn against the ask

describe("a surface with no door states the gap and offers no control", () => {
  test("IMPORT names the three verdicts and the missing door", () => {
    const markup = renderToStaticMarkup(createElement(ImportScreen));
    expect(markup).toContain(IMPORT_VERDICT.new);
    expect(markup).toContain(IMPORT_VERDICT.gapfill);
    expect(markup).toContain(IMPORT_VERDICT.held);
    expect(markup).toContain("[backend-needed]");
    expect(markup).not.toContain("<button");
  });

  test("ACCESS HISTORY describes the register and says it is not served here", () => {
    const markup = renderToStaticMarkup(createElement(AccessScreen));
    expect(markup).toContain("Filled");
    expect(markup).toContain("page origin");
    expect(markup).toContain(ACCESS_NOT_SERVED);
    expect(markup).not.toContain("<button");
  });

  test("EXPORT carries the §6 lede and NO control that would write plaintext", () => {
    const markup = renderToStaticMarkup(
      createElement(ExportScreen, { items: 312 })
    );
    expect(markup).toContain(EXPORT_LEDE);
    expect(markup).toContain("312 items");
    expect(markup).toContain(EXPORT_COMMIT_NOTE);
    expect(markup).not.toContain("<button");
  });

  test("COMPANION gives the three not-offered reasons verbatim, and dispatches nothing", () => {
    const markup = renderToStaticMarkup(createElement(FillScreen));
    expect(markup).toContain(NOT_OFFERED.policy);
    expect(markup).toContain(NOT_OFFERED.http);
    expect(markup).toContain(NOT_OFFERED.nomatch);
    expect(markup).toContain(FILL_WHERE);
    expect(markup).not.toContain("<button");
  });
});
