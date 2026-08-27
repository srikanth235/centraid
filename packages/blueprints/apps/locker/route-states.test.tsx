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

import { AccessScreen } from "./components/Access.tsx";
import { EditScreen } from "./components/Edit.tsx";
import { ExportScreen } from "./components/Export.tsx";
import { ImportScreen } from "./components/Import.tsx";
import { ReviewScreen } from "./components/Review.tsx";
import { SearchScreen } from "./components/Search.tsx";
import { FillScreen } from "./components/Surfaces.tsx";
import { TrashScreen } from "./components/Trash.tsx";
import { SEALED, emptySeed } from "./draft.ts";
import { reviewRegister } from "./review-model.ts";
import {
  ACCESS_EMPTY,
  ACCESS_NO_VALUES,
  ACCESS_OFFLINE,
  ALIAS_ROW,
  ALL_CLEAR,
  CUSTOM_ROW,
  EDIT_FOOT_OFFLINE,
  EDIT_SAVE,
  EXPORT_COMMIT,
  EXPORT_HISTORY,
  EXPORT_OFFLINE,
  EXPORT_TRASHED,
  FILL_WHERE,
  IMPORT_CHOOSE,
  IMPORT_NO_DOOR,
  IMPORT_OFFLINE,
  REVIEW_ATTENTION,
  REVIEW_CHANGE_IT,
  REVIEW_UNRUNNABLE,
  SEALED_UNCHANGED,
  TRASH_EMPTY,
  TRASH_PURGE,
  TRASH_RESTORE,
} from "./route-copy.ts";
import { emptySidecarDraft } from "./session.ts";
import type { LockerAccessEntry, LockerDetail, LockerRow } from "./types.ts";
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
        detail: null,
        sidecarDraft: emptySidecarDraft(),
        offline: false,
        busy: false,
        error: "",
        onChange: NOOP,
        onRetype: NOOP,
        onGenerate: NOOP,
        onSave: NOOP,
        onCancel: NOOP,
        onFieldDraft: NOOP,
        onFieldSave: NOOP,
        onFieldRemove: NOOP,
        onAddressDraft: NOOP,
        onAddressSave: NOOP,
        onPasskeyDraft: NOOP,
        onPasskeySave: NOOP,
        onPasskeyClear: NOOP,
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

  test("the type chip offers ALL FIFTEEN, not only the rail's six", () => {
    const markup = form({});
    for (const label of [
      "Login",
      "Card",
      "Secure note",
      "Identity",
      "Wi-Fi",
      "Password",
      "SSH key",
      "API credential",
      "Passport",
      "Bank account",
      "Driving licence",
      "Software licence",
      "Crypto wallet",
      "Membership",
      "Document",
    ]) {
      expect(markup, label).toContain(`>${label}<`);
    }
  });

  test("NO GAP TAG SURVIVES on the form — every row it named has a door", () => {
    const markup = form({});
    expect(markup).toContain(CUSTOM_ROW);
    expect(markup).not.toContain("[backend-needed]");
    expect(markup).not.toContain("[open-question]");
  });

  test("THE ALIAS IS A CONTROL, pre-filled, clearable and reassignable", () => {
    const markup = form({
      seed: { ...emptySeed(), mode: "edit", itemId: "l1", alias: "deploy-key" },
    });
    expect(markup).toContain(ALIAS_ROW);
    expect(markup).toContain('value="deploy-key"');
    // Not the old read-only row: there is a field to empty.
    expect(markup).toContain(`aria-label="${ALIAS_ROW}"`);
  });

  test("the sidecar editors are WITHHELD on a create, with the reason", () => {
    const markup = form({});
    expect(markup).toContain("once it is saved");
    expect(markup).not.toContain("Add a field");
  });

  test("an EDIT opens the item's own sections, addresses and passkey slot", () => {
    const detail: LockerDetail = {
      item_id: "l1",
      type: "login",
      title: "GitHub",
      fields: [
        {
          field_id: "f1",
          section: "Recovery",
          label: "Recovery code",
          kind: "sealed",
          value: null,
          sealed: true,
        },
      ],
      addresses: [
        {
          address_id: "a1",
          url: "https://alt.example.test",
          match_policy: "exact-host",
        },
      ],
    };
    const markup = form({
      seed: { ...emptySeed(), mode: "edit", itemId: "l1" },
      detail,
    });
    expect(markup).toContain("Recovery code");
    expect(markup).toContain("Add a field");
    expect(markup).toContain("https://alt.example.test");
    // The replace-all semantics are stated where the save is, not after it.
    expect(markup).toContain("replaces the whole list");
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

describe("IMPORT is live where the door is, and states the fact where it is not", () => {
  const DRAFT = {
    batchId: "b1",
    status: "draft",
    createdAt: "2026-01-15T09:00:00Z",
    summary: { "locker.item": 3 },
    kind: "1password",
    label: "1Password export",
  };
  const ROWS = [
    {
      seq: 1,
      entityType: "locker.item",
      externalId: "Netflix",
      disposition: "create",
      mapping: "title → title",
    },
    {
      seq: 2,
      entityType: "locker.item",
      externalId: "GitHub",
      disposition: "update",
      mapping: "username → username",
    },
    {
      seq: 3,
      entityType: "locker.item",
      externalId: "Bank",
      disposition: "skip",
      mapping: "password → password",
    },
  ];
  const importer = (props: Partial<Parameters<typeof ImportScreen>[0]>) =>
    renderToStaticMarkup(
      createElement(ImportScreen, {
        hasDoor: true,
        offline: false,
        batches: null,
        rows: null,
        openBatchId: null,
        note: "",
        onStage: NOOP,
        onOpen: NOOP,
        onPublish: NOOP,
        onDiscard: NOOP,
        ...props,
      })
    );

  test("the three verdicts are §6's, verbatim, whatever the draft holds", () => {
    const markup = importer({});
    expect(markup).toContain(IMPORT_VERDICT.new);
    expect(markup).toContain(IMPORT_VERDICT.gapfill);
    expect(markup).toContain(IMPORT_VERDICT.held);
    expect(markup).not.toContain("[backend-needed]");
  });

  test("DOOR PRESENT: a file can be staged, and the drafts are listed", () => {
    const markup = importer({ batches: [DRAFT] });
    expect(markup).toContain(IMPORT_CHOOSE);
    expect(markup).toContain("1Password export");
    expect(markup).toContain("Review");
  });

  test("DOOR ABSENT (C1): no control at all, and the seat that has it is named", () => {
    const markup = importer({ hasDoor: false, batches: [DRAFT] });
    expect(markup).toContain(IMPORT_NO_DOOR);
    expect(markup).not.toContain(IMPORT_CHOOSE);
    expect(markup).not.toContain("<input");
  });

  test("OFFLINE: the refusal is stated BEFORE a file is picked, not after", () => {
    const markup = importer({ offline: true, batches: [DRAFT] });
    expect(markup).toContain(IMPORT_OFFLINE);
    expect(markup).not.toContain(IMPORT_CHOOSE);
  });

  test("a reviewed draft wears one verdict per row, and the vault wins on held", () => {
    const markup = importer({
      batches: [DRAFT],
      openBatchId: "b1",
      rows: ROWS,
    });
    expect(markup).toContain("Netflix");
    expect(markup).toContain(IMPORT_VERDICT.held);
    expect(markup).toContain("Publish the draft");
    expect(markup).toContain("Discard the draft");
  });
});

// ------------------------------------------------- ACCESS HISTORY, now served

describe("ACCESS HISTORY draws the receipts and never a value", () => {
  const ENTRIES: LockerAccessEntry[] = [
    {
      receipt_id: "r1",
      kind: "auth",
      action: "unlock",
      decision: "allow",
      item_id: null,
      occurred_at: "2026-01-15T09:12:00Z",
    },
    {
      receipt_id: "r2",
      kind: "reveal",
      action: "reveal",
      decision: "allow",
      item_id: "l1",
      occurred_at: "2026-01-15T09:13:00Z",
      columns: ["password"],
    },
    {
      receipt_id: "r3",
      kind: "fill",
      action: "reveal",
      decision: "allow",
      item_id: "l1",
      occurred_at: "2026-01-15T09:14:00Z",
      origin: "https://github.test",
    },
    {
      receipt_id: "r4",
      kind: "auth",
      action: "unlock",
      decision: "deny",
      item_id: null,
      occurred_at: "2026-01-15T09:15:00Z",
      reason: "wrong passphrase",
    },
  ];
  const access = (props: Partial<Parameters<typeof AccessScreen>[0]>) =>
    renderToStaticMarkup(
      createElement(AccessScreen, {
        entries: ENTRIES,
        window: { window: 200, truncated: false },
        itemId: null,
        titles: new Map([["l1", "GitHub"]]),
        offline: false,
        onNarrow: NOOP,
        ...props,
      })
    );

  test("every kind is drawn, and a FILL carries its page origin", () => {
    const markup = access({});
    expect(markup).toContain("Unlocked");
    expect(markup).toContain("Revealed");
    expect(markup).toContain("Filled");
    expect(markup).toContain("https://github.test");
    expect(markup).toContain("GitHub");
    expect(markup).not.toContain("[backend-needed]");
  });

  test("A REFUSAL IS A ROW — listed like an allowance, with its reason", () => {
    const markup = access({});
    expect(markup).toContain("Refused");
    expect(markup).toContain("wrong passphrase");
  });

  test("a reveal names its COLUMNS and never a value", () => {
    const markup = access({});
    expect(markup).toContain("password");
    expect(markup).toContain(ACCESS_NO_VALUES);
  });

  test("NOTHING IS EMPTY UNTIL A READ HAS LANDED", () => {
    expect(access({ entries: null })).not.toContain(ACCESS_EMPTY);
    expect(access({ entries: [] })).toContain(ACCESS_EMPTY);
  });

  test("OFFLINE: no list, and the reason it cannot be answered here", () => {
    const markup = access({ offline: true });
    expect(markup).toContain(ACCESS_OFFLINE);
    expect(markup).not.toContain("https://github.test");
  });
});

// -------------------------------------------------------- EXPORT, now committed

describe("EXPORT carries §6's lede and a commit that names the consequence", () => {
  const exporter = (props: Partial<Parameters<typeof ExportScreen>[0]>) =>
    renderToStaticMarkup(
      createElement(ExportScreen, {
        items: 312,
        offline: false,
        busy: false,
        includeTrashed: false,
        includeHistory: false,
        onOption: NOOP,
        onAsk: NOOP,
        ...props,
      })
    );

  test("the lede is verbatim, and the count is the vault's", () => {
    const markup = exporter({});
    expect(markup).toContain(EXPORT_LEDE);
    expect(markup).toContain("312 items");
    expect(markup).not.toContain("[backend-needed]");
  });

  test("the commit exists, and both options are OFF unless asked for", () => {
    const markup = exporter({});
    expect(markup).toContain(EXPORT_COMMIT);
    expect(markup).toContain(`aria-pressed="false"`);
    expect(markup).toContain(EXPORT_TRASHED);
    expect(markup).toContain(EXPORT_HISTORY);
  });

  test("OFFLINE: the commit is WITHHELD, with the reason in its place", () => {
    const markup = exporter({ offline: true });
    expect(markup).toContain(EXPORT_OFFLINE);
    // Withheld, never disabled: the row stays, the BUTTON does not.
    expect(markup).not.toContain(`<button type="button" class="kit-btn">`);
    expect(markup).not.toContain("disabled");
  });
});

// ------------------------------------------- COMPANION: still where it happens

describe("COMPANION explains where the act happens and dispatches nothing", () => {
  test("the three not-offered reasons are §6's, and there is no control", () => {
    const markup = renderToStaticMarkup(createElement(FillScreen));
    expect(markup).toContain(NOT_OFFERED.policy);
    expect(markup).toContain(NOT_OFFERED.http);
    expect(markup).toContain(NOT_OFFERED.nomatch);
    expect(markup).toContain(FILL_WHERE);
    expect(markup).not.toContain("<button");
  });
});
