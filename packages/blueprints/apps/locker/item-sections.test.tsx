// @vitest-environment jsdom
// ONE ITEM'S SIX NEW SECTIONS, AND THE BOUNDARY THAT DID NOT MOVE (#872, #873).
//
// A VALUE THAT IS SEALED AT REST NEVER RIDES THE READ: `queries/item-sidecars`
// returns `sealed: true` with `value: null`. What #873 moved is the VERB — the
// sealed sidecar rows now offer `Reveal` and `Copy` through the same per-item
// permit gate the item's own sealed columns run on. Both halves are asserted
// together: presence is all the read carries, plaintext only after a reveal.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ItemScreen } from "./components/Item.tsx";
import {
  PASSKEY_KEY_FIELD,
  degradationCopy,
  historyPasswordKey,
  passwordAge,
  sealedFieldKey,
  sectionsOf,
  sidecarAskOf,
} from "./field-model.ts";
import { isPasswordStale } from "./format.ts";
import {
  ARCHIVE,
  ATTACHMENTS_NOTE,
  HISTORY_PASSWORD_LABEL,
  HISTORY_PASSWORD_PRESENT,
  PASSKEY_KEY_HELD,
  UNARCHIVE,
} from "./item-copy.ts";
import { SEALED_RUN } from "./item-fields.ts";
import type { LockerDetail, LockerRow } from "./types.ts";
import { REVEAL, SEALED_NOTE } from "./view-copy.ts";

const NOW = Date.parse("2026-01-15T00:00:00Z");
const NOOP = (): void => undefined;

const DETAIL: LockerDetail = {
  item_id: "l1",
  type: "login",
  title: "GitHub",
  username: "ana@example.test",
  url: "https://github.test",
  url_match_policy: "registrable-domain",
  alias: "deploy-key",
  password_set_at: "2020-01-01T00:00:00Z",
  fields: [
    {
      field_id: "f1",
      section: "Recovery",
      label: "Recovery code",
      kind: "sealed",
      value: null,
      sealed: true,
    },
    {
      field_id: "f2",
      section: "Recovery",
      label: "Reset address",
      kind: "url",
      value: "https://reset.github.test",
    },
  ],
  addresses: [
    {
      address_id: "a1",
      url: "https://alt.github.test",
      match_policy: "exact-host",
    },
  ],
  passkey: {
    rp_id: "github.test",
    display_name: "Ana",
    credential_id: "cred-1",
    algorithm: "ES256",
    created_at: "2025-11-02T10:00:00Z",
    has_private_key: true,
  },
  attachments: [
    {
      attachment_id: "at1",
      content_id: "c1",
      role: "attachment",
      title: "recovery-kit.pdf",
      media_type: "application/pdf",
      byte_size: 20_480,
    },
  ],
  history: [
    {
      revision_id: "rev2",
      operation: "edit",
      changed: { password: true },
      recorded_at: "2025-12-01T09:00:00Z",
      has_previous_password: true,
    },
    {
      revision_id: "rev1",
      operation: "create",
      changed: {},
      recorded_at: "2025-01-01T09:00:00Z",
    },
  ],
};

const ROW: LockerRow = { item_id: "l1", type: "login", title: "GitHub" };

/** The reveal state the orchestrator's bag would be holding, keyed exactly the
 *  way `field-model` keys it — one live reveal at a time, never two. */
function open(field: string, value: string) {
  return { revealed: { [field]: value }, revealedAt: { [field]: NOW } };
}

function item(
  over: Partial<LockerDetail> = {},
  reveal: {
    revealed?: Record<string, string>;
    revealedAt?: Record<string, number>;
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(ItemScreen, {
      detail: { ...DETAIL, ...over },
      row: ROW,
      revealed: reveal.revealed ?? {},
      revealedAt: reveal.revealedAt ?? {},
      now: NOW,
      onReveal: NOOP,
      onArchive: NOOP,
      onDuplicate: NOOP,
      onCopySecret: NOOP,
      onCopyCode: NOOP,
      onConceal: NOOP,
      onCopyMetadata: NOOP,
      onOpenAddress: NOOP,
      onStar: NOOP,
      onGenerate: NOOP,
      onTrash: NOOP,
    })
  );
}

describe("custom fields draw in their own sections", () => {
  test("the section is the head, and the vault's order is kept", () => {
    const groups = sectionsOf(DETAIL.fields);
    expect(groups.map((group) => group.section)).toStrictEqual(["Recovery"]);
    expect(groups[0]?.fields.map((field) => field.label)).toStrictEqual([
      "Recovery code",
      "Reset address",
    ]);
    const markup = item();
    expect(markup).toContain("Recovery");
    expect(markup).toContain("Reset address");
    expect(markup).toContain("https://reset.github.test");
  });

  test("A SEALED CUSTOM VALUE IS A DOT RUN UNTIL IT IS REVEALED", () => {
    const markup = item();
    expect(markup).toContain(SEALED_RUN);
    // It costs what every other secret on this screen costs, in §6's words.
    expect(markup).toContain(SEALED_NOTE);
    // The vault's own placeholder is not a value and is never drawn as one.
    expect(markup).not.toContain("«sealed»");
  });

  test("the sealed row offers the verbs the grant now carries (#873)", () => {
    const markup = item();
    const recovery = markup.slice(
      markup.indexOf("Recovery code"),
      markup.indexOf("Reset address")
    );
    // The grant gained `reveal` on `locker.item_field`, so the row asks for
    // what it can actually get — and never asks disabled.
    expect(recovery).toContain("<button");
    expect(recovery).toContain(">Reveal<");
    expect(recovery).toContain(">Copy<");
    expect(recovery).not.toContain("disabled");
  });

  test("the permit is minted against the FIELD ROW, by its own id", () => {
    const ask = sidecarAskOf(sealedFieldKey("f1"), DETAIL);
    expect(ask).toStrictEqual({
      target: {
        entity: "locker.item_field",
        entityId: "f1",
        column: "value_sealed",
      },
      label: "Recovery code",
    });
    // A field that is not sealed has nothing to reveal, and a key naming no
    // row at all mints nothing rather than guessing at one.
    expect(sidecarAskOf(sealedFieldKey("f2"), DETAIL)).toBeNull();
    expect(sidecarAskOf(sealedFieldKey("nope"), DETAIL)).toBeNull();
  });

  test("REVEALED, the plaintext is on the row and Conceal replaces Reveal", () => {
    const markup = item({}, open(sealedFieldKey("f1"), "r3c0very-c0de"));
    expect(markup).toContain("r3c0very-c0de");
    expect(markup).toContain("the receipt is already written");
    expect(markup).toContain(">Conceal<");
    // AND ONLY THAT ROW. One permit, one field: the passkey's key material and
    // the retained password beside it are still dot runs.
    expect(markup).toContain(SEALED_RUN);
  });

  test("NOTHING IS RETURNED UNTIL IT IS REVEALED — the read carries presence", () => {
    // The boundary that did not move: with an empty reveal bag, no sealed
    // value is anywhere on the screen, whatever verbs the rows now offer.
    const markup = item();
    expect(markup).toContain(REVEAL);
    expect(markup).not.toContain("r3c0very-c0de");
    // `readFields` reports the shape and never the secret.
    expect(DETAIL.fields?.[0]?.value).toBeNull();
    expect(DETAIL.fields?.[0]?.sealed).toBe(true);
  });
});

describe("several addresses, each with its own match policy", () => {
  test("the primary stays first, and every row names its policy", () => {
    const markup = item();
    const addresses = markup.slice(markup.indexOf("Addresses"));
    expect(addresses.indexOf("https://github.test")).toBeLessThan(
      addresses.indexOf("https://alt.github.test")
    );
    expect(markup).toContain("any host under the domain");
    expect(markup).toContain("that host, and nowhere else");
  });
});

describe("the passkey slot draws its metadata and the key's PRESENCE", () => {
  test("metadata reads plainly; key material is a run, a sentence and a verb", () => {
    const markup = item();
    expect(markup).toContain("github.test");
    expect(markup).toContain("ES256");
    expect(markup).toContain(PASSKEY_KEY_HELD);
    expect(markup).toContain(SEALED_RUN);
    const key = markup.slice(markup.indexOf("Key material"));
    expect(key).toContain(">Reveal<");
    expect(key).toContain(">Copy<");
  });

  test("the key row's permit names the ITEM, which is the row it hangs off", () => {
    expect(sidecarAskOf(PASSKEY_KEY_FIELD, DETAIL)).toStrictEqual({
      target: {
        entity: "locker.item_passkey",
        entityId: "l1",
        column: "private_key",
      },
      label: "Key material",
    });
    // No key material, nothing to reveal — the slot is the metadata alone.
    expect(
      sidecarAskOf(PASSKEY_KEY_FIELD, {
        ...DETAIL,
        passkey: { rp_id: "github.test", has_private_key: false },
      })
    ).toBeNull();
  });

  test("revealed, the key material is on the row and nothing else is", () => {
    const markup = item({}, open(PASSKEY_KEY_FIELD, "MHcCAQEE-key"));
    expect(markup).toContain("MHcCAQEE-key");
    expect(markup).toContain(">Conceal<");
  });

  test("no slot, no section — an absent passkey is not an empty one", () => {
    expect(item({ passkey: null })).not.toContain(PASSKEY_KEY_HELD);
  });
});

describe("attachments state the boundary they actually have", () => {
  test("what the file is, how big, and that the bytes ride the vault file", () => {
    const markup = item();
    expect(markup).toContain("recovery-kit.pdf");
    expect(markup).toContain("application/pdf");
    expect(markup).toContain("20 KB");
    expect(markup).toContain(ATTACHMENTS_NOTE);
    // AND IT DOES NOT CLAIM SEALING. The sealed class is a COLUMN class.
    expect(ATTACHMENTS_NOTE).not.toContain("sealed");
  });
});

describe("history names what changed, and never what it changed from", () => {
  test("the operation, the columns and the time — newest first", () => {
    const markup = item();
    const history = markup.slice(markup.indexOf("History"));
    expect(history).toContain("edit");
    expect(history).toContain("password");
    expect(history.indexOf("2025-12-01")).toBeLessThan(
      history.indexOf("2025-01-01")
    );
  });

  test("a retained previous password is PRESENT, and now has its own verbs", () => {
    const markup = item();
    expect(markup).toContain(HISTORY_PASSWORD_PRESENT);
    // The revision is metadata; the password it kept is a sealed row of its
    // own, beneath it, so a `Reveal` never sits next to a timestamp.
    const history = markup.slice(markup.indexOf("History"));
    expect(history).toContain(HISTORY_PASSWORD_LABEL);
    expect(history).toContain(">Reveal<");
    expect(history).toContain(">Copy<");
  });

  test("the permit is minted against the REVISION, and only a retaining one", () => {
    expect(sidecarAskOf(historyPasswordKey("rev2"), DETAIL)).toStrictEqual({
      target: {
        entity: "locker.item_history",
        entityId: "rev2",
        column: "password",
      },
      label: HISTORY_PASSWORD_LABEL,
    });
    // `rev1` kept nothing — there is no row to spend a permit on.
    expect(sidecarAskOf(historyPasswordKey("rev1"), DETAIL)).toBeNull();
  });

  test("a revealed previous password is on its row, and never in the read", () => {
    const markup = item({}, open(historyPasswordKey("rev2"), "0ld-passw0rd"));
    expect(markup).toContain("0ld-passw0rd");
    expect(markup).toContain(">Conceal<");
    // The payload the pane was given still carries presence and nothing else.
    expect(DETAIL.history?.[0]?.has_previous_password).toBe(true);
    expect(item()).not.toContain("0ld-passw0rd");
  });

  test("the password's AGE is read off the item's own clock", () => {
    expect(passwordAge("2020-01-01T00:00:00Z", NOW)).toContain("years ago");
    expect(item()).toContain("Password age");
    // A row the vault never dated is not old — it is undated.
    expect(passwordAge(null, NOW)).toBe("");
    expect(isPasswordStale({ ...ROW }, NOW)).toBe(false);
  });
});

describe("a type this build cannot draw is NAMED, not relabelled", () => {
  test("the stored discriminant and §3's sentence are both on the screen", () => {
    const markup = item({ type: "note", degraded_from: "ssh_key" });
    expect(markup).toContain("ssh_key");
    expect(markup).toContain(
      "degrades to a note with custom fields rather than to nothing"
    );
  });

  test("an undegraded item says nothing about a stored type", () => {
    expect(degradationCopy(null)).toBeNull();
    expect(item()).not.toContain("Stored type");
  });
});

describe("archive and duplicate are the life row, and archive is not trash", () => {
  test("the verb flips with the state, and the note refuses a purge date", () => {
    expect(item()).toContain(ARCHIVE);
    expect(item({ archived: true })).toContain(UNARCHIVE);
    expect(item()).toContain("nothing is scheduled to be purged");
    expect(item()).not.toContain("purges in");
  });

  test("duplicate says the alias does not travel with the copy", () => {
    expect(item()).toContain("the alias is not carried over");
  });
});

describe("the alias is read back, which is the paper cut §8 names", () => {
  test("the binding that exists is on the screen", () => {
    expect(item()).toContain("deploy-key");
    expect(item({ alias: null })).toContain("None");
  });
});
