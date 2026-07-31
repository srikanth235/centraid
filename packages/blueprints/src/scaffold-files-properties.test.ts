/**
 * App-scaffold file-map laws (#656 Layer 3 mutation seed).
 *
 * `scaffold-files.ts` + `app-rewrites.ts` are how every Centraid app comes
 * into being and how every rename propagates. The existing tests assert that
 * a scaffold "has the canonical files" and that a rename "changes the title" —
 * true of a great many wrong implementations. Deleting the `_` guard from
 * `validateAppId`, replacing `replaceAll` with `replace` in `escapeHtml`,
 * emitting `actions`/`queries` as non-empty, loosening the
 * `automations/<id>/automation.json` path regex, or dropping the
 * case-insensitive duplicate-name check all survived.
 *
 * Each test below names the law the mutant breaks.
 */
import { describe, expect, it } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { applyManifestName, rewriteTitleInHtml } from "./app-rewrites.js";
import {
  appPackageJson,
  escapeHtml,
  scaffoldAppFiles,
  updateAppMetaFiles,
  validateAppId,
} from "./scaffold-files.js";
import type { ScaffoldFile } from "./scaffold-files.js";

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
      // …and a rejected id never yields files.
      expect(() => scaffoldAppFiles(id), id).toThrow(/Invalid app id/u);
    }
  });

  it("names the offending id in the error so the operator can see the typo", () => {
    expect(() => validateAppId("Bad Id")).toThrow(/"Bad Id"/u);
  });
});

describe(escapeHtml, () => {
  it("escapes every occurrence, not just the first", () => {
    // `replace` instead of `replaceAll` leaves the second angle bracket raw —
    // which is the whole XSS.
    expect(escapeHtml("<<>>&&\"\"''")).toBe(
      "&lt;&lt;&gt;&gt;&amp;&amp;&quot;&quot;&#39;&#39;"
    );
  });

  it("escapes the ampersand first, so entities are not double-escaped", () => {
    // Escaping `<` before `&` yields `&amp;lt;` — visible garbage in the tab.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves no unescaped markup character in the output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const escaped = escapeHtml(raw);
        // Strip the entities we emitted; nothing dangerous may remain.
        const residue = escaped.replaceAll(/&(?:amp|lt|gt|quot|#39);/gu, "");
        expect(residue).not.toMatch(/[<>&"']/u);
      }),
      { numRuns: 150, seed: 65661 }
    );
  });

  it("is a no-op on text with nothing to escape", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9 ._-]{0,30}$/u), (safe) => {
        expect(escapeHtml(safe)).toBe(safe);
      }),
      { numRuns: 80, seed: 65662 }
    );
  });
});

describe(scaffoldAppFiles, () => {
  it("emits a file map with unique, app-relative, traversal-free paths", () => {
    fc.assert(
      fc.property(validId, (id) => {
        const files = scaffoldAppFiles(id);
        const paths = files.map((f) => f.path);
        expect(new Set(paths).size).toBe(paths.length);
        for (const p of paths) {
          expect(p.startsWith("/"), p).toBe(false);
          expect(p, p).not.toContain("\\");
          expect(p.split("/"), p).not.toContain("..");
          expect(p.trim()).toBe(p);
        }
        // Nothing may be emitted empty — the git store would publish a blank.
        for (const f of files)
          expect(f.content.length, f.path).toBeGreaterThan(0);
      }),
      { numRuns: 60, seed: 65663 }
    );
  });

  it("declares no actions and no queries until the agent writes one", () => {
    // A non-empty default would advertise handlers that do not exist, and the
    // shell would render dead buttons.
    const appJson = JSON.parse(
      byPath(scaffoldAppFiles("todos")).get("app.json") as string
    ) as { actions: unknown[]; queries: unknown[]; manifestVersion: number };
    expect(appJson.actions).toStrictEqual([]);
    expect(appJson.queries).toStrictEqual([]);
    expect(appJson.manifestVersion).toBe(1);
  });

  it("defaults the version and honours an explicit one", () => {
    const fallback = JSON.parse(
      byPath(scaffoldAppFiles("todos")).get("app.json") as string
    ) as { version: string };
    expect(fallback.version).toBe("0.1.0");
    const explicit = JSON.parse(
      byPath(scaffoldAppFiles("todos", { version: "2.3.4" })).get(
        "app.json"
      ) as string
    ) as { version: string };
    expect(explicit.version).toBe("2.3.4");
  });

  it("omits a blank description entirely rather than storing an empty string", () => {
    for (const description of ["", "   ", "\n\t"]) {
      const appJson = JSON.parse(
        byPath(scaffoldAppFiles("todos", { description })).get(
          "app.json"
        ) as string
      ) as Record<string, unknown>;
      expect("description" in appJson, JSON.stringify(description)).toBe(false);
    }
  });

  it("ships four knobs, each with a default that is one of its own options", () => {
    const appJson = JSON.parse(
      byPath(scaffoldAppFiles("todos")).get("app.json") as string
    ) as {
      knobs: Array<{
        key: string;
        label: string;
        type: string;
        default: string;
        options: Array<{ value: string; label: string }>;
      }>;
    };
    expect(appJson.knobs).toHaveLength(4);
    expect(appJson.knobs.map((k) => k.key)).toStrictEqual([
      "appFont",
      "appWidth",
      "appRadius",
      "appColor",
    ]);
    for (const knob of appJson.knobs) {
      expect(knob.label, knob.key).not.toBe("");
      expect(knob.options.length, knob.key).toBeGreaterThan(1);
      // A default outside the option list renders the picker with nothing
      // selected — the settings popover's silent-failure mode.
      expect(
        knob.options.map((o) => o.value),
        knob.key
      ).toContain(knob.default);
      for (const option of knob.options) {
        expect(option.label, `${knob.key}/${option.value}`).not.toBe("");
      }
    }
  });

  it("HTML-escapes the display name in the <title> it stamps", () => {
    const files = byPath(
      scaffoldAppFiles("todos", { name: '<img src=x onerror="p">' })
    );
    const html = files.get("index.html") as string;
    expect(html).toContain(
      "<title>&lt;img src=x onerror=&quot;p&quot;&gt;</title>"
    );
    expect(html).not.toContain("<img");
  });

  it("names the package after the id and keeps it private and ESM", () => {
    fc.assert(
      fc.property(validId, (id) => {
        const pkg = JSON.parse(appPackageJson(id)) as Record<string, unknown>;
        expect(pkg.name).toBe(`centraid-app-${id}`);
        // Private + type:module are load-bearing: a published-by-accident app
        // or a CJS one would not run in the app engine.
        expect(pkg.private).toBe(true);
        expect(pkg.type).toBe("module");
        expect(pkg.version).toBe("0.1.0");
      }),
      { numRuns: 60, seed: 65664 }
    );
    // Emitted as pretty JSON with a trailing newline (git-store friendly).
    expect(appPackageJson("todos").endsWith("}\n")).toBe(true);
    expect(appPackageJson("todos")).toContain("\n  ");
  });

  it("emits app.json as pretty JSON with a trailing newline", () => {
    const appJson = byPath(scaffoldAppFiles("todos")).get("app.json") as string;
    expect(appJson.endsWith("}\n")).toBe(true);
    expect(appJson).toContain("\n  ");
  });
});

describe(updateAppMetaFiles, () => {
  const base = (): ScaffoldFile[] =>
    scaffoldAppFiles("todos", { name: "Todos" });

  it("returns ONLY the files whose content actually changed", () => {
    // Returning an unchanged file would rewrite it in the git store and put a
    // no-op commit in the app's history.
    const changed = updateAppMetaFiles(base(), "todos", {});
    expect(changed.map((f) => f.path)).toStrictEqual(["app.json"]);

    const renamed = updateAppMetaFiles(base(), "todos", { name: "Tasks" });
    expect(renamed.map((f) => f.path).sort()).toStrictEqual([
      "app.json",
      "index.html",
    ]);
    // Renaming to the SAME name leaves index.html byte-identical, so it must
    // not be returned.
    expect(
      updateAppMetaFiles(base(), "todos", { name: "Todos" }).map((f) => f.path)
    ).toStrictEqual(["app.json"]);
  });

  it("trims the new name before storing and comparing it", () => {
    const changed = byPath(
      updateAppMetaFiles(base(), "todos", { name: "  Tasks  " })
    );
    expect(
      (JSON.parse(changed.get("app.json") as string) as { name: string }).name
    ).toBe("Tasks");
    expect(changed.get("index.html")).toContain("<title>Tasks</title>");
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
    const start = scaffoldAppFiles("todos", {
      name: "Todos",
      description: "keep me",
    });
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
    expect(after.knobs).toStrictEqual(before.knobs);
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
      "index.html",
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

describe(rewriteTitleInHtml, () => {
  it("rewrites the first <title> and leaves any later one alone", () => {
    const html = "<title>A</title><body><title>B</title>";
    expect(rewriteTitleInHtml(html, "N")).toBe(
      "<title>N</title><body><title>B</title>"
    );
  });

  it("returns the input unchanged when there is no <title>", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z <>/]{0,40}$/u), (html) => {
        if (/<title>/iu.test(html)) return;
        expect(rewriteTitleInHtml(html, "N")).toBe(html);
      }),
      { numRuns: 80, seed: 65670 }
    );
  });

  it("matches a multi-line or attributed title tag case-insensitively", () => {
    expect(rewriteTitleInHtml("<TITLE>\n  Old\n</TITLE>", "New")).toBe(
      "<title>New</title>"
    );
  });

  it("treats $-sequences in the new name as literal text", () => {
    // `String.replace` with a string argument would interpret `$&` as the
    // whole match, smuggling the old title back into the tab.
    for (const name of ["$&", "$1", "$$", "$`"]) {
      expect(rewriteTitleInHtml("<title>Old</title>", name), name).toBe(
        `<title>${name.replaceAll("&", "&amp;")}</title>`
      );
    }
  });

  it("escapes markup in the new name", () => {
    expect(rewriteTitleInHtml("<title>Old</title>", "<script>x</script>")).toBe(
      "<title>&lt;script&gt;x&lt;/script&gt;</title>"
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
