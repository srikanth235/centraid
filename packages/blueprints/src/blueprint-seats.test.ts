/*
 * Docs/blueprint-seats.md decisions S1/S2/S5, checked mechanically:
 *
 *   - S1/S2 machine-readable split — every bundled UI app declares an
 *     `app.json#seats` block, and the record-only class (`byteBearing:
 *     false`) never imports the custody vocabulary or the transfer engine.
 *     This is a TRIPWIRE, not a proof: it greps source text for a handful
 *     of literal names (`local-only`, `remote-only`, `backupState`, and any
 *     import path containing `kit/transfer`). A determined author could
 *     dodge it with an alias or a computed string — the point is to catch
 *     the ordinary "I copy-pasted from Photos" mistake, not a sabotage
 *     attempt.
 *   - S5 — Locker is the one app that declares `disabledOn: ["viewer"]`
 *     today; this file also documents Tally's byte-bearing EDGE (receipt
 *     photos are byte-bearing even though Tally's own class is record-only)
 *     since a JSON-adjacent comment isn't possible inside app.json itself.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const APPS_DIR = path.join(PACKAGE_ROOT, "apps");

interface SeatsBlock {
  byteBearing: boolean;
  originActs: string[];
  disabledOn: string[];
  northStar: string;
}

function appIds(): string[] {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .toSorted();
}

function readSeats(id: string): SeatsBlock | undefined {
  const raw = JSON.parse(
    readFileSync(path.join(APPS_DIR, id, "app.json"), "utf8")
  ) as { seats?: SeatsBlock };
  return raw.seats;
}

// Every TypeScript/TSX source file under an app's own directory (not its
// node_modules, not its dist) — the same universe a "did you import the
// wrong thing" grep should cover.
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// The custody vocabulary (docs/blueprint-seats.md "Byte custody
// vocabulary") a record-only app has no business naming, plus the one
// shared engine path (`kit/transfer`, owned by another agent — see this
// file's sibling receipt) that only a byte-bearing app should import.
const CUSTODY_TERMS = ["local-only", "remote-only", "backupState"] as const;
const TRANSFER_IMPORT_RE = /kit\/transfer/u;

describe("blueprint seats (docs/blueprint-seats.md S1/S2/S5)", () => {
  // [law:custody-seat-exclusion] Record-only apps cannot import byte custody.
  const ids = appIds();

  it.each(ids.map((id) => [id] as const))(
    "apps/%s declares a seats block",
    (id) => {
      const seats = readSeats(id);
      expect(seats, `apps/${id}/app.json is missing "seats"`).toBeDefined();
      expect(seats?.byteBearing).toBeTypeOf("boolean");
      expect(Array.isArray(seats?.originActs)).toBe(true);
      expect(Array.isArray(seats?.disabledOn)).toBe(true);
      expect(seats?.northStar).toBeTypeOf("string");
    }
  );

  it("classes every app exactly as docs/blueprint-seats.md's north-star table", () => {
    const byId = Object.fromEntries(ids.map((id) => [id, readSeats(id)]));
    // The doc's "Two classes of blueprint" table, id-for-id. A mismatch here
    // means either the doc or an app.json drifted — fix whichever is wrong
    // in the same PR (docs/blueprint-seats.md's own preamble).
    const expectedByteBearing: Record<string, boolean> = {
      photos: true,
      docs: true,
      notes: true,
      agenda: false,
      tasks: false,
      people: false,
      locker: true,
      // Tally is record-only in class, but its mobile origin act (receipt
      // photo) is byte-bearing AT THAT ONE EDGE — the north-star table's own
      // footnote. `byteBearing` here is the app-wide class flag, so it's
      // `false`; the edge is instead visible as `originActs: ["camera"]`
      // with no matching custody machinery elsewhere in the app.
      tally: false,
    };
    for (const [id, expected] of Object.entries(expectedByteBearing)) {
      expect(byId[id]?.byteBearing, `apps/${id} byteBearing`).toBe(expected);
    }
  });

  const recordOnlyIds = ids.filter(
    (id) => readSeats(id)?.byteBearing === false
  );

  it("covers the doc's record-only roster (tasks, agenda, people, tally)", () => {
    expect(recordOnlyIds.toSorted()).toStrictEqual(
      ["agenda", "people", "tally", "tasks"].toSorted()
    );
  });

  it.each(recordOnlyIds.map((id) => [id] as const))(
    "apps/%s (record-only) does not reference custody vocabulary or the transfer engine",
    (id) => {
      const dir = path.join(APPS_DIR, id);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        for (const term of CUSTODY_TERMS) {
          expect(text).not.toContain(term);
        }
        expect(
          TRANSFER_IMPORT_RE.test(text),
          `${path.relative(PACKAGE_ROOT, file)} imports the transfer engine (kit/transfer) — record-only apps must not (docs/blueprint-seats.md S2)`
        ).toBe(false);
      }
    }
  );

  it("Locker is the only app disabled on a seat, and it's the viewer seat (S5)", () => {
    const disabled = ids
      .map((id) => [id, readSeats(id)?.disabledOn ?? []] as const)
      .filter(([, disabledOn]) => disabledOn.length > 0);
    expect(disabled).toStrictEqual([["locker", ["viewer"]]]);
  });
});
