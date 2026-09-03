// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ItemScreen } from "./components/Item.tsx";
import {
  PASSKEY_KEY_FIELD,
  degradationCopy,
  passwordAge,
  sealedFieldKey,
  sectionsOf,
  sidecarAskOf,
} from "./field-model.ts";
import { isPasswordStale } from "./format.ts";
import {
  ARCHIVE,
  ATTACHMENTS_NOTE,
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
      operation: "update",
      changed: { password: true },
      recorded_at: "2025-12-01T09:00:00Z",
    },
    {
      revision_id: "rev1",
      operation: "update",
      changed: { username: true },
      recorded_at: "2025-01-01T09:00:00Z",
    },
  ],
};

const ROW: LockerRow = { item_id: "l1", type: "login", title: "GitHub" };

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
    expect(markup).toContain(SEALED_NOTE);
    expect(markup).not.toContain("«sealed»");
  });

  test("the sealed row offers the verbs the grant now carries (#873)", () => {
    const markup = item();
    const recovery = markup.slice(
      markup.indexOf("Recovery code"),
      markup.indexOf("Reset address")
    );
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
    expect(sidecarAskOf(sealedFieldKey("f2"), DETAIL)).toBeNull();
    expect(sidecarAskOf(sealedFieldKey("nope"), DETAIL)).toBeNull();
  });

  test("REVEALED, the plaintext is on the row and Conceal replaces Reveal", () => {
    const markup = item({}, open(sealedFieldKey("f1"), "r3c0very-c0de"));
    expect(markup).toContain("r3c0very-c0de");
    expect(markup).toContain("the receipt is already written");
    expect(markup).toContain(">Conceal<");
    expect(markup).toContain(SEALED_RUN);
  });

  test("NOTHING IS RETURNED UNTIL IT IS REVEALED — the read carries presence", () => {
    const markup = item();
    expect(markup).toContain(REVEAL);
    expect(markup).not.toContain("r3c0very-c0de");
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
    expect(ATTACHMENTS_NOTE).not.toContain("sealed");
  });
});

describe("history names what changed, and never what it changed from", () => {
  test("the operation, the columns and the time — newest first", () => {
    const markup = item();
    const history = markup.slice(markup.indexOf("History"));
    expect(history).toContain("update");
    expect(history).toContain("password");
    expect(history).toContain("username");
    expect(history.indexOf("2025-12-01")).toBeLessThan(
      history.indexOf("2025-01-01")
    );
  });

  test("a rotation is named, and the old value is placed rather than offered", () => {
    const history = item().slice(item().indexOf("History"));
    expect(history).toContain(HISTORY_PASSWORD_PRESENT);
    expect(HISTORY_PASSWORD_PRESENT).toContain("export");
    expect(history).toContain("2025-12-01");
    expect(history).not.toContain(">Reveal<");
    expect(history).not.toContain(">Copy<");
    expect(history).not.toContain(">Conceal<");
  });

  test("a revision that left the password alone says nothing about one", () => {
    const markup = item({
      history: [
        {
          revision_id: "rev1",
          operation: "update",
          changed: { username: true },
          recorded_at: "2025-01-01T09:00:00Z",
        },
      ],
    });
    expect(markup).not.toContain(HISTORY_PASSWORD_PRESENT);
  });

  test("no revision is an address a permit can be minted for", () => {
    for (const key of ["history:rev2", "history:rev1", "history:"])
      expect(sidecarAskOf(key, DETAIL)).toBeNull();
    expect(
      JSON.stringify(sidecarAskOf(sealedFieldKey("f1"), DETAIL))
    ).not.toContain("item_history");
  });

  test("the password's AGE is read off the item's own clock", () => {
    expect(passwordAge("2020-01-01T00:00:00Z", NOW)).toContain("years ago");
    expect(item()).toContain("Password age");
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
