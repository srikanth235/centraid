#!/usr/bin/env node
// THE n/a-CELL AUDIT (#890 W6).
//
// `tests/matrix.json` carries 56 cells that are deliberately not owned — a seat
// an app disables, an engine an app has no entity for, a dimension a surface is
// not the right place to assert. Every one cites a doctrine anchor or an issue,
// and `validate-app-axes.mjs` already checks that those citations RESOLVE.
//
// What nothing checked is the distinction that decides whether the cell is
// finished. An n/a is one of two different things:
//
//   IMPOSSIBILITY  the claim cannot arise. Agenda has no placeable entity, so
//     there is no placement behaviour to assert — an owner would have to invent
//     the situation it tested. Nothing more is owed; the citation IS the proof.
//
//   PROHIBITION    the claim must never arise. Locker declares
//     `seats.disabledOn: ["viewer"]`, so the PWA seat must REFUSE at the mount
//     path. That is not an absence of behaviour, it is a behaviour: something
//     has to fail if the app ever renders there. A prohibition with no gate is a
//     rule the codebase merely intends.
//
// Both read identically in the matrix — `status: "skip"` with a citation — which
// is exactly why the difference rotted invisibly. This audit makes each cell
// declare which it is, and makes a prohibition name the gate that owns it.
//
// IT DOES NOT BACKFILL. #890's non-goals say so explicitly: the 56 are
// deliberate and the ritual is re-verification, not conversion. What it forbids
// is an n/a nobody has re-read since the ruling that created it.
//
// Runs in the same PR loop as its siblings — it is pure file reading and costs
// milliseconds, and a "periodic ritual" that depends on somebody remembering to
// run it is the thing this repo keeps learning not to build.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REGISTER_PATH = "tests/na-cells.json";
const MATRIX_PATH = "tests/matrix.json";

// Two quarters. Long enough that the ritual is not busywork against 56 cells,
// short enough that no deliberate absence outlives the reasoning behind it.
const REVIEW_WINDOW_DAYS = 183;

const dayMs = 24 * 60 * 60 * 1000;
/** Whole days between an ISO date and `now`, or null when unparseable. */
export function ageInDays(reviewed, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(reviewed ?? ""))) return null;
  const parsed = Date.parse(`${reviewed}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((now - parsed) / dayMs);
}

/** Every non-owned cell in the matrix, keyed `<grid>.<app-or-surface>.<axis>`. */
export function collectNaCells(matrix) {
  const cells = new Map();
  for (const app of matrix.appSeats?.apps ?? []) {
    for (const [seat, cell] of Object.entries(app.seats ?? {})) {
      if (cell.status === "owned") continue;
      cells.set(`appSeats.${app.id}.${seat}`, { ...cell, grid: "appSeats" });
    }
  }
  for (const app of matrix.appEngines?.apps ?? []) {
    for (const [engine, cell] of Object.entries(app.engines ?? {})) {
      if (cell.status === "pass") continue;
      cells.set(`appEngines.${app.id}.${engine}`, {
        ...cell,
        grid: "appEngines",
      });
    }
  }
  for (const surface of matrix.surfaces ?? []) {
    for (const [dimension, status] of Object.entries(
      surface.assessment ?? {}
    )) {
      if (status !== "skip") continue;
      cells.set(`surface.${surface.id}.${dimension}`, {
        status,
        grid: "surface",
      });
    }
  }
  return cells;
}

/** The rule engine, pure over an injected world. */
export function auditNaCells({
  cells,
  register,
  gateExists,
  docAnchorExists,
  now = Date.now(),
}) {
  const findings = [];
  const fail = (rule, message) => findings.push({ rule, message });
  const rows = register.cells ?? {};

  for (const key of cells.keys()) {
    if (!rows[key]) {
      fail(
        "classified",
        `${key} is a deliberate n/a with no row in ${REGISTER_PATH}. Declare it ` +
          `\`impossibility\` (the claim cannot arise — the citation is the whole ` +
          `proof) or \`prohibition\` (the claim must never arise — name the gate ` +
          `that makes it fail). Both read as "skip" in the matrix, which is why ` +
          `the difference has to be stated somewhere.`
      );
    }
  }

  for (const [key, row] of Object.entries(rows)) {
    if (!cells.has(key)) {
      fail(
        "no-phantom",
        `${REGISTER_PATH} classifies ${key}, which is no longer a non-owned cell. ` +
          `A cell that gained an owner must lose its n/a row, or the register ` +
          `describes a matrix that no longer exists.`
      );
      continue;
    }
    if (row.kind !== "impossibility" && row.kind !== "prohibition") {
      fail(
        "classified",
        `${key} declares kind ${JSON.stringify(row.kind)}; it must be ` +
          `"impossibility" or "prohibition".`
      );
      continue;
    }
    if (!(row.restated?.length > 40)) {
      fail(
        "restated",
        `${key} has no \`restated\` sentence. The ritual is re-verification: say ` +
          `why this cell is still not owned, so a reader can tell whether the ` +
          `original ruling still applies rather than trusting that somebody once ` +
          `thought so.`
      );
    }
    // The DATE is what makes this a ritual rather than a register. A row nobody
    // has re-read since a ruling two years ago is exactly the state the audit
    // exists to surface, and the only way to clear it is to read the cell again
    // and re-date it — which is a deliberate act somebody signs.
    const age = ageInDays(row.reviewed, now);
    if (age == null) {
      fail(
        "reviewed",
        `${key} carries no usable \`reviewed\` date (got ${JSON.stringify(row.reviewed)}). ` +
          `An undated n/a is one nobody can tell has been re-read.`
      );
    } else if (age > REVIEW_WINDOW_DAYS) {
      fail(
        "reviewed",
        `${key} was last reviewed ${age} days ago (window ${REVIEW_WINDOW_DAYS}). ` +
          `Re-read the cell against its citation and re-date it, or give it an ` +
          `owner. Do not bump the date without reading the cell — that is the one ` +
          `move this ritual cannot detect and the only one that makes it worthless.`
      );
    }
    if (row.kind === "prohibition") {
      const gate = row.gate;
      if (typeof gate !== "string" || !gateExists(gate)) {
        fail(
          "prohibition-gate",
          `${key} is a PROHIBITION — the claim must never arise — but names no ` +
            `gate that exists (got ${JSON.stringify(gate)}). "Must never happen" ` +
            `with nothing enforcing it is an intention, not a rule. Point it at ` +
            `the conformance test or linter that fails when it does happen.`
        );
      }
    }
    for (const citation of [row.citation].filter(Boolean)) {
      if (citation.includes("#") && !citation.startsWith("#")) {
        if (!docAnchorExists(citation)) {
          fail(
            "citation",
            `${key} cites ${citation}, whose document or anchor no longer exists. ` +
              `A doctrine citation that does not resolve is an n/a resting on nothing.`
          );
        }
      }
    }
  }

  return findings;
}

// ---- self-test: the rules on fixtures, before judging the repo.
function selfTest() {
  const cells = new Map([["appSeats.locker.viewer", { status: "skip" }]]);
  const restated = "a".repeat(60);
  const reviewed = "2026-08-30";
  const base = {
    cells,
    gateExists: (gate) => gate === "real.test.ts",
    docAnchorExists: (citation) => citation === "docs/x.md#anchor",
    now: Date.parse("2026-08-30T00:00:00Z"),
  };
  const cases = [
    {
      name: "an unclassified cell is flagged",
      register: { cells: {} },
      want: ["classified"],
    },
    {
      name: "a phantom row is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "impossibility",
            restated,
            reviewed,
          },
          "gone.cell.axis": { kind: "impossibility", restated, reviewed },
        },
      },
      want: ["no-phantom"],
    },
    {
      name: "a classified impossibility with a restatement is clean",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "impossibility",
            restated,
            reviewed,
          },
        },
      },
      want: [],
    },
    {
      name: "an unrestated cell is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": { kind: "impossibility", reviewed },
        },
      },
      want: ["restated"],
    },
    {
      name: "an unknown kind is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": { kind: "someday", restated, reviewed },
        },
      },
      want: ["classified"],
    },
    {
      name: "a prohibition with no gate is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": { kind: "prohibition", restated, reviewed },
        },
      },
      want: ["prohibition-gate"],
    },
    {
      name: "a prohibition naming a gate that does not exist is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "prohibition",
            restated,
            reviewed,
            gate: "ghost.test.ts",
          },
        },
      },
      want: ["prohibition-gate"],
    },
    {
      name: "a prohibition with a real gate is clean",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "prohibition",
            restated,
            reviewed,
            gate: "real.test.ts",
          },
        },
      },
      want: [],
    },
    {
      name: "a cell nobody has re-read inside the window is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "impossibility",
            restated,
            reviewed: "2020-01-01",
          },
        },
      },
      want: ["reviewed"],
    },
    {
      name: "a broken doctrine citation is flagged",
      register: {
        cells: {
          "appSeats.locker.viewer": {
            kind: "impossibility",
            restated,
            reviewed,
            citation: "docs/gone.md#anchor",
          },
        },
      },
      want: ["citation"],
    },
  ];
  for (const testCase of cases) {
    const got = [
      ...new Set(
        auditNaCells({ ...base, register: testCase.register }).map(
          (f) => f.rule
        )
      ),
    ].sort();
    const want = [...new Set(testCase.want)].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(
        `FAIL — audit-na-cells self-test "${testCase.name}": expected [${want}], got [${got}]`
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  const read = (rel) => readFileSync(path.resolve(ROOT, rel), "utf8");
  const matrix = JSON.parse(read(MATRIX_PATH));
  const register = JSON.parse(read(REGISTER_PATH));
  const cells = collectNaCells(matrix);

  // Silent-no-op guard: an empty cell set reads as "everything is owned", which
  // would be wonderful and is not what a matrix-shape change looks like.
  if (cells.size === 0) {
    console.error(
      `\nFAIL — found zero non-owned cells in ${MATRIX_PATH}. Either every cell ` +
        `gained an owner (say so deliberately) or the grid shape moved.\n`
    );
    process.exit(1);
  }

  const gateExists = (gate) =>
    existsSync(path.resolve(ROOT, gate.split("#")[0]));
  const docAnchorExists = (citation) => {
    const [doc, anchor] = citation.split("#");
    const abs = path.resolve(ROOT, doc);
    if (!existsSync(abs)) return false;
    if (!anchor) return true;
    // Anchors are GitHub-style slugs of a heading; compare on the slug so a
    // heading's punctuation can change without breaking every citation to it.
    const slugs = new Set(
      read(doc)
        .split("\n")
        .filter((line) => line.startsWith("#"))
        .map((line) =>
          line
            .replace(/^#+\s*/u, "")
            .toLowerCase()
            .replaceAll(/[^\w\s-]/gu, "")
            .trim()
            .replaceAll(/\s+/gu, "-")
        )
    );
    return slugs.has(anchor);
  };

  const findings = auditNaCells({
    cells,
    register,
    gateExists,
    docAnchorExists,
  });
  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} n/a-cell defect(s): a deliberate absence nobody ` +
        `has re-read, or a prohibition nothing enforces.\n`
    );
    for (const finding of findings)
      console.error(`  [${finding.rule}] ${finding.message}\n`);
    console.error(`See ${REGISTER_PATH} and issue #890.\n`);
    process.exit(1);
  }

  const rows = Object.values(register.cells ?? {});
  const prohibitions = rows.filter((row) => row.kind === "prohibition");
  console.log(
    `ok   na-cells — ${cells.size} deliberate n/a cell(s): ` +
      `${rows.length - prohibitions.length} impossibility, ${prohibitions.length} ` +
      `prohibition, each of the latter owned by a gate that exists`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
