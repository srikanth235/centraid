import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { ONTOLOGY_VERSION } from "./migrate.js";
import {
  ONTOLOGY_DOC_SCHEMAS,
  docColumnTuple,
  liveMachineryTables,
  liveOntologyDoc,
  parseDataLiteral,
  parseOntologyDocMachinery,
  parseOntologyDocSchemas,
} from "./ontology-doc.js";
import type { DocTable } from "./ontology-doc.js";

const PAGE = new URL(
  "../../../../scripts/docs-site/src/content/ontology-body.html",
  import.meta.url
);

describe("the ontology page matches the live schema", () => {
  let db: VaultDb;
  let html: string;
  let live: DocTable[];

  beforeAll(() => {
    db = openVaultDb();
    html = readFileSync(PAGE, "utf8");
    live = liveOntologyDoc(db.vault);
  });

  afterAll(() => {
    db.vault.close();
  });

  it("carries the version the vault stamps", () => {
    expect(html).toContain(`ontology v${ONTOLOGY_VERSION}`);
  });

  it("describes exactly the in-scope schemas, in registry order", () => {
    const page = parseOntologyDocSchemas(html);
    expect(page.map((s) => s.id)).toStrictEqual([...ONTOLOGY_DOC_SCHEMAS]);
  });

  it("describes every registered table of those schemas and no other", () => {
    const page = parseOntologyDocSchemas(html);
    for (const schema of page) {
      const expected = live
        .filter((t) => t.schema === schema.id)
        .map((t) => t.table);
      expect(
        schema.tables.map((t) => t.n),
        `§03 ${schema.id}: table list`
      ).toStrictEqual(expected);
    }
  });

  it("draws every column with the live name, order, type, flags and reference", () => {
    const page = parseOntologyDocSchemas(html);
    const failures: string[] = [];
    for (const schema of page) {
      for (const table of schema.tables) {
        const liveTable = live.find(
          (t) => t.schema === schema.id && t.table === table.n
        );
        if (!liveTable) continue; // reported by the table-list assertion
        const drawn = table.cols.map((c) => ({
          name: c[0] ?? "",
          type: (c[1] ?? "").split(/[\s(]/u)[0]!.toUpperCase(),
          flags: (c[2] ?? "").trim(),
          fk: c[3] ?? "",
        }));
        const expected = liveTable.cols.map((c) => ({
          name: c.name,
          type: c.type,
          flags: c.flags,
          fk: c.fk,
        }));
        if (JSON.stringify(drawn) !== JSON.stringify(expected)) {
          failures.push(
            `${schema.id}.${table.n} — the page should draw:\n` +
              liveTable.cols.map((c) => `  ${docColumnTuple(c)},`).join("\n")
          );
        }
        for (const c of table.cols) {
          if (!(c[4] ?? "").trim()) {
            failures.push(`${schema.id}.${table.n}.${c[0]}: purpose is empty`);
          }
        }
      }
    }
    expect(failures, failures.join("\n\n")).toStrictEqual([]);
  });

  it("names every machinery-band table, and only registered ones", () => {
    const page = parseOntologyDocMachinery(html);
    const expected = liveMachineryTables();
    expect(page.map((band) => band.id)).toStrictEqual(Object.keys(expected));
    for (const band of page) {
      expect([...band.tables].sort(), `machinery ${band.id}`).toStrictEqual(
        [...expected[band.id]!].sort()
      );
    }
  });

  it("no longer describes retired tables anywhere", () => {
    const arrays = html.slice(html.indexOf("const SCHEMAS"));
    for (const retired of [
      "social.contact_card",
      "consent.share",
      "home.asset_item",
      "business.invoice",
      "tally.expense_receipt",
      "share.grant",
    ]) {
      expect(arrays, retired).not.toContain(`'${retired}'`);
    }
  });
});

describe("the page is parsed, never executed", () => {
  it("reads the grammar §03 is hand-authored in", () => {
    expect(
      parseDataLiteral(
        `[{ id:'core', n:2, ok:true, gone:null,
            desc:'CHECK in (\\'active\\',\\'locked\\') · <span class="k">x</span>',
            cols:[['vault_id','TEXT','PK',''],], },]`
      )
    ).toStrictEqual([
      {
        id: "core",
        n: 2,
        ok: true,
        gone: null,
        desc: `CHECK in ('active','locked') · <span class="k">x</span>`,
        cols: [["vault_id", "TEXT", "PK", ""]],
      },
    ]);
  });

  it("refuses every token that would evaluate", () => {
    for (const hostile of [
      "[process.mainModule]",
      "[require('node:fs')]",
      "['a'].concat(['b'])",
      "[`template`]",
      "[] ; process.exit(1)",
      "[1 + 1]",
      "[function () {}]",
    ]) {
      expect(() => parseDataLiteral(hostile), hostile).toThrow(
        /ontology page:/u
      );
    }
  });

  it("refuses a malformed literal rather than guessing at it", () => {
    for (const broken of ["['unterminated", "[1,,2]", "{a 1}", "[", "{"]) {
      expect(() => parseDataLiteral(broken), broken).toThrow(/ontology page:/u);
    }
  });

  it("keeps a `__proto__` key as data", () => {
    const parsed = parseDataLiteral(`{'__proto__':{'polluted':1}}`) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });
});
