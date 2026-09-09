// The rule harness: the one way a law rule is defined, and the one way it is
// tested (#1005).
//
// A directive written in bash is a script that happens to fail; a rule written
// here is a *declaration* that ESLint already knows how to run, report,
// suppress, document and unit-test. Nothing in this file re-implements
// machinery ESLint provides — `defineRule` only fixes the metadata every law
// rule must carry, and `ruleTester` only wires ESLint's own `RuleTester` to
// `node:test` and to the two languages the law is written over.
//
// Rules stay pure and synchronous over the document they lint. Anything that
// needs git, the network or the clock belongs in the generator (`arrival.mjs`),
// whose output is itself a document the rules then read.
import { RuleTester } from "eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import { describe, it } from "node:test";

/** Doors a rule can be enforced at. See README.md § The two doors. */
export const DOORS = Object.freeze(["hook", "window", "owner"]);

/** Surfaces a rule can be written over. */
export const SURFACES = Object.freeze(["arrival", "documents"]);

/**
 * Define a law rule.
 *
 * @param {object} spec The rule declaration.
 * @param {string} spec.id Rule id, as it appears in a pack's `rules` map.
 * @param {string} spec.statute The CONSTITUTION.md anchor this rule enforces,
 *   e.g. `#one-receipt-per-issue`. Becomes `meta.docs.url`, which is what
 *   ESLint prints beside a finding — the citation travels with the verdict.
 * @param {"hook"|"window"|"owner"} spec.door Where this rule is answerable.
 * @param {string} spec.description One line, imperative, for `meta.docs`.
 * @param {string} [spec.enforces] What the rule makes impossible.
 * @param {string} [spec.observes] What it only reports, the host enforcing it.
 * @param {"arrival"|"documents"} [spec.surface] Which document it reads.
 * @param {object[]} [spec.schema] ESLint options schema.
 * @param {(context: object) => object} spec.create The visitor factory.
 * @returns {object} An ESLint rule object.
 */
export function defineRule(spec) {
  const {
    id,
    statute,
    door,
    description,
    enforces,
    observes,
    surface = "arrival",
    schema = [],
    create,
  } = spec;
  if (!id) throw new TypeError("defineRule: id is required");
  if (!statute) throw new TypeError(`defineRule(${id}): statute is required`);
  if (!DOORS.includes(door))
    throw new TypeError(`defineRule(${id}): door must be one of ${DOORS.join(", ")}`);
  if (!description) throw new TypeError(`defineRule(${id}): description is required`);
  if (!SURFACES.includes(surface))
    throw new TypeError(`defineRule(${id}): surface must be one of ${SURFACES.join(", ")}`);
  if (typeof create !== "function")
    throw new TypeError(`defineRule(${id}): create must be a function`);
  // A rule that observes without enforcing must say so: the CODEOWNERS/branch
  // -protection boundary is the difference between a report and a refusal, and
  // a reader of the rule catalog must not have to guess which one they have.
  if (!enforces && !observes)
    throw new TypeError(`defineRule(${id}): declare enforces and/or observes`);
  return {
    meta: {
      type: "problem",
      docs: { description, url: `CONSTITUTION.md${statute}` },
      // Non-standard keys ESLint carries through untouched. The runner reads
      // them to build the per-door config and the front page.
      door,
      surface,
      law: { id, statute, enforces: enforces ?? null, observes: observes ?? null },
      schema,
    },
    create,
  };
}

/**
 * A `RuleTester` wired to `node:test` and to the law's two languages.
 *
 * `.json` fixtures are parsed by `@eslint/json` and `.md` fixtures by
 * `@eslint/markdown`, so a test names its fixture by filename and gets the
 * same parse the runner performs.
 *
 * @param {"arrival"|"documents"} [surface] Which language to install.
 * @returns {RuleTester} The tester.
 */
export function ruleTester(surface = "arrival") {
  RuleTester.describe = describe;
  RuleTester.it = it;
  return surface === "documents"
    ? new RuleTester({
        plugins: { markdown },
        language: "markdown/commonmark",
      })
    : new RuleTester({ plugins: { json }, language: "json/json" });
}
