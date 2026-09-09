// Every `invalid` case is a hole in the loop: a principle nobody could resolve,
// a section promising a directive that does not exist, and a directive nobody
// published a section for.
import rule from "./constitution-coverage.mjs";
import { ruleTester } from "../lib/rule.mjs";

const FILE = "/repo/CONSTITUTION.md";
const CATALOG = {
  rules: ["amendment-pairing", "estate-separation"],
  anchors: ["#the-quality-ladder-915", "#q-1005-1"],
};

/**
 * A whole constitution, small enough to read.
 *
 * @param {string[]} principles The bullets, without their `- `.
 * @param {string[]} sections The `### ` ids under `## Directives`.
 * @returns {string} The document.
 */
const doc = (principles, sections) =>
  [
    "# Constitution",
    "",
    "## Principles",
    "",
    ...principles.map((line) => `- ${line}`),
    "",
    "## Directives",
    "",
    "## srikanth235/centraid",
    "",
    ...sections.flatMap((id) => [`### ${id}`, "", "- **Directive**: something.", ""]),
    "## Amendment process",
    "",
    "1. Write it.",
    "",
  ].join("\n");

const CITED = [
  "Amendments land with their test. — rule: amendment-pairing",
  "The law is reviewed on its own. — rule: estate-separation",
  "Green-only evidence is incomplete. — decision: #the-quality-ladder-915",
  "Docs are load-bearing. — owner question: #q-1005-1",
];
const SECTIONS = ["amendment-pairing", "estate-separation"];

ruleTester("documents").run("constitution-coverage", rule, {
  valid: [
    { code: doc(CITED, SECTIONS), filename: FILE, options: [CATALOG] },
    // Any other document is not this rule's business.
    { code: doc(["An uncited principle."], []), filename: "/repo/QUALITY.md", options: [CATALOG] },
  ],
  invalid: [
    {
      // The uncited principle: the case the whole rule exists for.
      code: doc([...CITED, "Everything should be nice."], SECTIONS),
      filename: FILE,
      options: [CATALOG],
      errors: [{ message: /this principle cites nothing/u }],
    },
    {
      code: doc(
        [...CITED, "Nothing is slow. — rule: perceived-latency"],
        SECTIONS
      ),
      filename: FILE,
      options: [CATALOG],
      errors: [{ message: /cites rule 'perceived-latency', which no pack enables/u }],
    },
    {
      code: doc([...CITED, "Docs are current. — decision: #no-such-section"], SECTIONS),
      filename: FILE,
      options: [CATALOG],
      errors: [{ message: /cites decision '#no-such-section', which docs\/decisions\.md does not carry/u }],
    },
    {
      code: doc(CITED, [...SECTIONS, "retired-directive"]),
      filename: FILE,
      options: [CATALOG],
      errors: [{ message: /'### retired-directive' states a directive that does not exist/u }],
    },
    {
      // A rule enforced with nothing published about it.
      code: doc(CITED, ["amendment-pairing"]),
      filename: FILE,
      options: [CATALOG],
      errors: [{ message: /'estate-separation' is enforced but this document has no/u }],
    },
  ],
});
