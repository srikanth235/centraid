// Vocabulary guard for the Photos app (#599): the storage noun "vault" must
// never reach user-visible copy except reviewed #731 phrases.
//
// HOW THE SCAN TELLS COPY FROM CODE: (1) comments stripped by a quote-aware
// state machine so `//` inside strings survives; (2) the offence regex is
// edge-bounded — prose matches, `x.vault.read`/`vaultDenied`/`VAULT_ACCESS`
// never do. Only .ts/.tsx/.html scanned; app.json excluded on purpose (it is
// the machine-readable contract, not copy).
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PHOTOS_DIR = path.resolve(import.meta.dirname, "../apps/photos");
const SCANNED = new Set([".ts", ".tsx", ".html"]);

/** Every scannable source file under the Photos app, repo-relative. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (SCANNED.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

/** Drop `<!-- -->`, `/* *\/` and `//` comments; keep string contents intact. */
function stripComments(source: string): string {
  const withoutHtml = source.replace(/<!--[\s\S]*?-->/gu, " ");
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < withoutHtml.length; i += 1) {
    const ch = withoutHtml[i]!;
    const next = withoutHtml[i + 1];
    if (quote) {
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < withoutHtml.length && withoutHtml[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < withoutHtml.length &&
        !(withoutHtml[i] === "*" && withoutHtml[i + 1] === "/")
      ) {
        i += 1;
      }
      i += 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** The word as a user would read it: whitespace/edge bounded, not `x.vault`. */
const OFFENCE = /(?:^|[\s>({[])vault(?=[\s.,!;:?'’"”)\]}<-]|$)/gimu;
const APPROVED_VAULT_COPY = [
  /\bSave to my vault\b/giu,
  /\bSaved to my vault\b/giu,
  /\bsaved to your vault\b/giu,
  /\bthis vault(?:'s|’s) device-only policy\b/giu,
  /\bthe vault(?:'s|’s) enrichment policy\b/giu,
  /\bthis vault permits gateway recognition\b/giu,
  /\bthe vault permits gateway recognition\b/giu,
];

function offences(source: string): string[] {
  const stripped = stripComments(source);
  const hits: string[] = [];
  for (const line of stripped.split("\n")) {
    const unapproved = APPROVED_VAULT_COPY.reduce(
      (copy, approved) => copy.replace(approved, ""),
      line
    );
    OFFENCE.lastIndex = 0;
    if (OFFENCE.test(unapproved)) hits.push(line.trim());
  }
  return hits;
}

describe("Photos app vocabulary (#599)", () => {
  it("scans a non-trivial number of Photos sources", () => {
    expect(sourceFiles(PHOTOS_DIR).length).toBeGreaterThan(20);
  });

  it("shows the storage noun only in reviewed ownership copy", () => {
    const found: string[] = [];
    for (const file of sourceFiles(PHOTOS_DIR)) {
      for (const line of offences(fs.readFileSync(file, "utf8"))) {
        found.push(`${path.relative(PHOTOS_DIR, file)}: ${line}`);
      }
    }
    expect(found).toStrictEqual([]);
  });

  it("distinguishes code and comments from prose", () => {
    // Code: dotted member expression, never prose.
    expect(
      offences("await ctx.vault.read({ entity: 'media.asset' })")
    ).toStrictEqual([]);
    expect(offences("const denied = data?.vaultDenied;")).toStrictEqual([]);
    expect(offences("if (e.code === 'VAULT_ACCESS') return;")).toStrictEqual(
      []
    );
    // Comments: stripped before the scan, both forms.
    expect(offences("// the vault owns the meaning here")).toStrictEqual([]);
    expect(offences("/* a projection of your vault */")).toStrictEqual([]);
    expect(offences("<!-- your vault, rendered -->")).toStrictEqual([]);
    // A `//` inside a string is not a comment; the prose after it is scanned.
    expect(
      offences("const help = 'https://x/y — see your vault';")
    ).toHaveLength(1);
    // Prose: string literal and JSX text alike.
    expect(offences("const tag = 'a projection of your vault';")).toHaveLength(
      1
    );
    expect(offences("<div>Uploaded to your vault</div>")).toHaveLength(1);
    expect(
      offences("<p>Turned off for this vault. Turn it on.</p>")
    ).toHaveLength(1);
    expect(offences("<strong>Vault</strong>")).toHaveLength(1);
  });
});
