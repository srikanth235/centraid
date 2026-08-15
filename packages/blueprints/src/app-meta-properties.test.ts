/**
 * App id + metadata-patch laws (#656 Layer 3 mutation seed).
 *
 * `app-meta.ts` guards the two things every app-owning route depends on: the
 * id shape that keeps a write inside the app's own directory, and the
 * changed-files-only patch the git store commits. The ordinary tests assert
 * that a rename "changes the name" — true of a great many wrong
 * implementations. Deleting the `_` guard from `validateAppId`, loosening the
 * `automations/<id>/automation.json` path regex, returning unchanged files, or
 * dropping the case-insensitive duplicate-name check all survived.
 *
 * Each test below names the law the mutant breaks.
 */
import { describe, expect, it } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { updateAppMetaFiles, validateAppId } from "./app-meta.js";
import { applyManifestName } from "./app-rewrites.js";
import type { ScaffoldFile } from "./scaffold-types.js";

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

const validId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/u);

describe(validateAppId, () => {
  it("accepts exactly the documented shape", () => {
    fc.assert(
      fc.property(validId, (id) => {
        expect(() => validateAppId(id)).not.toThrow();
      }),
      { numRuns: 120, seed: 65660 }
    );
    // Boundaries: 1 char and 63 chars are in; 64 is out.
    expect(() => validateAppId("a")).not.toThrow();
    expect(() => validateAppId(`a${"b".repeat(62)}`)).not.toThrow();
    expect(() => validateAppId(`a${"b".repeat(63)}`)).toThrow(
      /Invalid app id/u
    );
  });

  it("rejects every shape that could escape the app directory or shadow a reserved id", () => {
    const rejected = [
      "", // empty
      "_private", // reserved prefix
      "_", // reserved prefix alone
      "-leading", // must start alphanumeric
      "UPPER", // lowercase only
      "with space",
      "with.dot", // a dot is what makes `..` expressible
      "..",
      "../escape",
      "a/b",
      "a\\b",
      "tab\tid",
      "emoji🙂",
    ];
    for (const id of rejected) {
      expect(() => validateAppId(id), id).toThrow(/Invalid app id/u);
      // …and a rejected id never patches a file map either.
      expect(() => updateAppMetaFiles([], id, { name: "X" }), id).toThrow(
        /Invalid app id/u
      );
    }
  });

  it("names the offending id in the error so the operator can see the typo", () => {
    expect(() => validateAppId("Bad Id")).toThrow(/"Bad Id"/u);
  });
});

describe(updateAppMetaFiles, () => {
  const base = (extra: Record<string, unknown> = {}): ScaffoldFile[] => [
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id: "todos",
            name: "Todos",
            version: "0.1.0",
            iconKey: "Sparkle",
            ...extra,
          },
          null,
          2
        ) + "\n",
    },
  ];

  it("returns ONLY the files whose content actually changed", () => {
    // Returning an unchanged file would rewrite it in the git store and put a
    // no-op commit in the app's history.
    expect(
      updateAppMetaFiles(base(), "todos", {}).map((f) => f.path)
    ).toStrictEqual(["app.json"]);

    const manifest = JSON.stringify({ name: "Todos" }, null, 2) + "\n";
    const withAutomation: ScaffoldFile[] = [
      ...base(),
      { path: "automations/wake/automation.json", content: manifest },
    ];
    expect(
      updateAppMetaFiles(withAutomation, "todos", { name: "Tasks" })
        .map((f) => f.path)
        .sort()
    ).toStrictEqual(["app.json", "automations/wake/automation.json"]);
    // Renaming to the SAME name leaves the manifest byte-identical, so it
    // must not be returned.
    expect(
      updateAppMetaFiles(withAutomation, "todos", { name: "Todos" }).map(
        (f) => f.path
      )
    ).toStrictEqual(["app.json"]);
  });

  it("trims the new name before storing and comparing it", () => {
    const changed = byPath(
      updateAppMetaFiles(base(), "todos", { name: "  Tasks  " })
    );
    expect(
      (JSON.parse(changed.get("app.json") as string) as { name: string }).name
    ).toBe("Tasks");
  });

  it("rejects a whitespace-only name instead of clearing it", () => {
    for (const name of ["", " ", "\t\n"]) {
      expect(() => updateAppMetaFiles(base(), "todos", { name })).toThrow(
        /cannot be empty/u
      );
    }
  });

  it("compares duplicate display names case- and whitespace-insensitively", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Other", "OTHER", "other", "  OtHeR  "),
        (existing) => {
          expect(() =>
            updateAppMetaFiles(base(), "todos", { name: "other" }, [
              { id: "sibling", name: existing },
            ])
          ).toThrow(/already exists/u);
        }
      ),
      { numRuns: 20, seed: 65665 }
    );
    // A sibling with no name at all is not a collision.
    expect(() =>
      updateAppMetaFiles(base(), "todos", { name: "Other" }, [{ id: "s" }])
    ).not.toThrow();
    // The app's own row never collides with itself.
    expect(() =>
      updateAppMetaFiles(base(), "todos", { name: "Todos" }, [
        { id: "todos", name: "Todos" },
      ])
    ).not.toThrow();
  });

  it("clears the description on a blank patch and keeps it otherwise", () => {
    const start = base({ description: "keep me" });
    const cleared = JSON.parse(
      byPath(updateAppMetaFiles(start, "todos", { description: "  " })).get(
        "app.json"
      ) as string
    ) as Record<string, unknown>;
    expect("description" in cleared).toBe(false);

    const kept = JSON.parse(
      byPath(
        updateAppMetaFiles(start, "todos", { description: "  next  " })
      ).get("app.json") as string
    ) as { description: string };
    expect(kept.description).toBe("next");

    // An absent `description` key leaves the existing value alone.
    const untouched = JSON.parse(
      byPath(updateAppMetaFiles(start, "todos", {})).get("app.json") as string
    ) as { description: string };
    expect(untouched.description).toBe("keep me");
  });

  it("preserves every other app.json key across a rename", () => {
    const changed = byPath(
      updateAppMetaFiles(base(), "todos", { name: "Tasks" })
    );
    const before = JSON.parse(
      byPath(base()).get("app.json") as string
    ) as Record<string, unknown>;
    const after = JSON.parse(changed.get("app.json") as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(after).sort()).toStrictEqual(Object.keys(before).sort());
    expect(after.id).toBe(before.id);
    expect(after.iconKey).toBe(before.iconKey);
  });

  it("rebuilds app.json from scratch when the current one is not a JSON object", () => {
    // NOTE: a top-level JSON *array* is deliberately not in this list —
    // `typeof [] === "object"`, so today it is adopted and the rename is lost
    // when it is re-serialised. Pinning that here would freeze the gap; it is
    // reported as a #656 Layer 3 finding instead.
    for (const content of ["{not json", "null", '"a string"', "7"]) {
      const files: ScaffoldFile[] = [{ path: "app.json", content }];
      const out = JSON.parse(
        byPath(updateAppMetaFiles(files, "todos", { name: "Tasks" })).get(
          "app.json"
        ) as string
      ) as Record<string, unknown>;
      // A salvaged array/scalar would produce `{"0":1,"1":2,"name":…}`.
      expect(out, content).toStrictEqual({ name: "Tasks" });
    }
  });

  it("propagates a rename only to exact automations/<id>/automation.json paths", () => {
    const manifest = (name: string): string =>
      JSON.stringify({ name }, null, 2) + "\n";
    const files: ScaffoldFile[] = [
      ...base(),
      { path: "automations/wake/automation.json", content: manifest("Todos") },
      // Near misses that must NOT be rewritten.
      { path: "automations/automation.json", content: manifest("Todos") },
      {
        path: "automations/wake/nested/automation.json",
        content: manifest("Todos"),
      },
      {
        path: "automations/wake/automation.json.bak",
        content: manifest("Todos"),
      },
      {
        path: "x/automations/wake/automation.json",
        content: manifest("Todos"),
      },
    ];
    const changed = updateAppMetaFiles(files, "todos", { name: "Tasks" }).map(
      (f) => f.path
    );
    expect(changed.sort()).toStrictEqual([
      "app.json",
      "automations/wake/automation.json",
    ]);
  });

  it("leaves generated.{by,at} alone on a rename (clone-only stamp)", () => {
    const generated = { by: "tmpl", at: "2020-01-01T00:00:00.000Z" };
    const files: ScaffoldFile[] = [
      ...base(),
      {
        path: "automations/wake/automation.json",
        content: JSON.stringify({ name: "Todos", generated }, null, 2) + "\n",
      },
    ];
    const out = byPath(updateAppMetaFiles(files, "todos", { name: "Tasks" }));
    const mf = JSON.parse(
      out.get("automations/wake/automation.json") as string
    ) as { name: string; generated: { by: string; at: string } };
    expect(mf.name).toBe("Tasks");
    expect(mf.generated).toStrictEqual(generated);
  });

  it("skips an unparseable automation manifest without failing the rename", () => {
    const files: ScaffoldFile[] = [
      ...base(),
      { path: "automations/broken/automation.json", content: "{oops" },
      {
        path: "automations/ok/automation.json",
        content: JSON.stringify({ name: "Todos" }, null, 2) + "\n",
      },
    ];
    const changed = updateAppMetaFiles(files, "todos", { name: "Tasks" }).map(
      (f) => f.path
    );
    expect(changed).toContain("automations/ok/automation.json");
    expect(changed).not.toContain("automations/broken/automation.json");
  });

  it("validates the id before doing any work", () => {
    expect(() => updateAppMetaFiles(base(), "_bad", { name: "X" })).toThrow(
      /Invalid app id/u
    );
  });
});

describe(applyManifestName, () => {
  const manifest = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name: "Old", schedule: "0 9 * * *", ...extra }, null, 2) +
    "\n";

  it("rewrites name and preserves every other key", () => {
    const out = JSON.parse(
      applyManifestName(manifest(), "New") as string
    ) as Record<string, unknown>;
    expect(out.name).toBe("New");
    expect(out.schedule).toBe("0 9 * * *");
  });

  it("re-stamps generated only when asked, and always as an ISO instant", () => {
    const before = manifest({
      generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
    });
    const untouched = JSON.parse(
      applyManifestName(before, "New") as string
    ) as { generated: { by: string; at: string } };
    expect(untouched.generated.by).toBe("tmpl");

    const stamped = JSON.parse(
      applyManifestName(before, "New", { stampGenerated: true }) as string
    ) as { generated: { by: string; at: string } };
    expect(stamped.generated.by).toBe("centraid-builder");
    expect(stamped.generated.at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(stamped.generated.at).toISOString()).toBe(
      stamped.generated.at
    );
  });

  it("returns null on unparseable input so the caller can skip the file", () => {
    for (const raw of ["", "{oops", "not json"]) {
      expect(applyManifestName(raw, "New"), raw).toBeNull();
    }
  });

  it("emits pretty JSON with a trailing newline", () => {
    const out = applyManifestName(manifest(), "New") as string;
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).toContain("\n  ");
  });
});
