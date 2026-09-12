// No unwritten law, and no law nobody wrote down (#1005).
//
// An agent is held only to what was published before it acted, so a principle
// that resolves to nothing is not a principle — it is a mood, and holding
// somebody to a mood is the failure this constitution exists to prevent. This
// rule closes the loop in both directions:
//
//   every principle → a statute. Each bullet under `## Principles` ends with
//                     `— rule: <id>`, `— decision: <anchor>` or
//                     `— owner question: <anchor>`. What cannot be made a
//                     statute becomes a question recorded in
//                     `docs/decisions.md` and cited — never silently dropped.
//   every directive → a section. Each `### <id>` under `## Directives` names a
//                     rule or a shell directive that exists, and each thing in
//                     the catalog has a `### <id>`. A directive with no section
//                     is a rule nobody published; a section with no directive
//                     is a promise nothing keeps.
//
// The catalog and the anchor list arrive as OPTIONS, resolved once by the
// derived config from the packs, the directive folders and `docs/decisions.md`.
// The rule reads one document and its options, and nothing else.
import { defineRule } from "../lib/rule.ts";

/** `— rule: x`, `— decision: #x`, `— owner question: #x` — em dash or `--`. */
const CITATION =
  /(?:—|--)\s*(?<kind>rule|decision|owner question):\s*(?<target>[^\s.]+)\s*\.?\s*$/u;

/**
 * The bullets under `## Principles` and the ids under `## Directives`.
 *
 * @param {string} text The constitution.
 * @returns {{principles: {line: number, text: string}[], sections: {line: number, id: string}[]}}
 *   What the document declares.
 */
export function parseConstitution(text: string) {
  const principles = [];
  const sections = [];
  let inPrinciples = false;
  let inDirectives = false;
  for (const [index, line] of text.split("\n").entries()) {
    const heading = /^(?<hashes>#{2,6})\s+(?<title>.+?)\s*$/u.exec(line);
    if (heading) {
      const { hashes, title } = heading.groups;
      if (hashes.length === 2) {
        inPrinciples = title === "Principles";
        // `## Directives` opens the catalog and every later `##` is a pack
        // heading inside it, until the amendment process closes it.
        if (title === "Directives") inDirectives = true;
        else if (title === "Amendment process" || title === "Evolution Log") inDirectives = false;
      }
      if (hashes.length === 3 && inDirectives) {
        sections.push({ line: index + 1, id: title });
      }
      continue;
    }
    if (inPrinciples && line.startsWith("- ")) {
      principles.push({ line: index + 1, text: line.slice(2) });
    }
  }
  return { principles, sections };
}

export default defineRule({
  id: "constitution-coverage",
  statute: "#constitution-coverage",
  door: "window",
  surface: "documents",
  catalog: true,
  description: "Every principle resolves to a statute, and every directive has one.",
  enforces:
    "an uncited principle, a section naming a directive that does not exist, and a directive with no section — the required `governance` check carries all three",
  schema: [{ type: "object", additionalProperties: true }],
  create(context) {
    if (!context.filename.replaceAll("\\", "/").endsWith("CONSTITUTION.md")) return {};
    const judge = () => {
      const options = context.options[0] ?? {};
      const rules = new Set(options.rules);
      const anchors = new Set(options.anchors);
      const { principles, sections } = parseConstitution(context.sourceCode.getText());
      const at = (line) => ({
        loc: { start: { line, column: 0 }, end: { line, column: 1 } },
      });

      for (const principle of principles) {
        const match = CITATION.exec(principle.text);
        if (match === null) {
          context.report({
            ...at(principle.line),
            message: `this principle cites nothing. End it with '— rule: <id>', '— decision: <docs/decisions.md anchor>' or '— owner question: <anchor>'; a principle that resolves to nothing is a mood, and an agent is held only to what was published before it acted.`,
          });
          continue;
        }
        const { kind, target } = match.groups;
        if (kind === "rule" && !rules.has(target)) {
          context.report({
            ...at(principle.line),
            message: `this principle cites rule '${target}', which no pack enables and no directive folder defines. Cite one that exists, or record the gap as an owner question in docs/decisions.md.`,
          });
        }
        if (kind !== "rule" && !anchors.has(target.toLowerCase())) {
          context.report({
            ...at(principle.line),
            message: `this principle cites ${kind} '${target}', which docs/decisions.md does not carry. An anchor nobody can follow is the same as no citation at all.`,
          });
        }
      }

      const covered = new Set();
      for (const section of sections) {
        covered.add(section.id);
        if (rules.has(section.id)) continue;
        context.report({
          ...at(section.line),
          message: `'### ${section.id}' states a directive that does not exist — no pack enables a rule by that id and no directive folder defines one. A statute with nothing behind it is exactly the wish this document says a directive is not.`,
        });
      }
      for (const id of [...rules].sort()) {
        if (covered.has(id)) continue;
        context.report({
          ...at(1),
          message: `'${id}' is enforced but this document has no '### ${id}' section. A rule nobody published is a rule nobody agreed to; write the section, or repeal the rule.`,
        });
      }
    };
    return { root: judge, Document: judge };
  },
});
