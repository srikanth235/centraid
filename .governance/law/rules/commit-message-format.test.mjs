// Every `invalid` case here is a red the shell directive demonstrated: a
// subject that is not a Conventional Commit, one over 100 characters, and one
// with no issue reference. The `valid` cases are its skips and its waiver.
import rule from "./commit-message-format.mjs";
import { ruleTester } from "../lib/rule.mjs";

/**
 * A minimal arrival record carrying one commit.
 *
 * @param {string} subject The subject under test.
 * @param {object} [extra] Fields to merge into the record.
 * @returns {string} The record, as the JSON a rule lints.
 */
const withCommit = (subject, extra = {}) =>
  JSON.stringify(
    {
      schema: 2,
      commits: [{ sha: "0123456789abcdef", authorEmail: "a@b.c", subject, body: "", parents: [], files: [] }],
      pending: null,
      waivers: [],
      registries: {},
      ...extra,
    },
    null,
    2
  );

const long = `feat(governance): ${"x".repeat(90)} (#1005)`;

ruleTester().run("commit-message-format", rule, {
  valid: [
    withCommit("feat(governance): the law directory (#1005)"),
    withCommit("fix: a subject with no scope (#7)"),
    withCommit("feat(x)!: a breaking change (#7)"),
    // Skips the directive made, kept verbatim.
    withCommit("Merge branch 'main' into lane/1005-b"),
    withCommit('Revert "feat: something (#1)"'),
    withCommit("fixup! feat: something (#1)"),
    // A bot's commit is judged by whoever wrote the bot.
    withCommit("bump deps", {
      commits: [
        { sha: "abc", authorEmail: "49699333+dependabot[bot]@users.noreply.github.com", subject: "bump deps", body: "", parents: [], files: [] },
      ],
    }),
    // The in-body waiver, with a reason.
    withCommit("release 1.2.3", {
      waivers: [
        { directive: "commit-message-format", path: null, reason: "release commit", source: "commit:0123456789abcdef" },
      ],
    }),
    // A pending message is judged too, and a good one passes.
    JSON.stringify({
      schema: 2,
      commits: [],
      pending: { message: "docs(governance): a pending subject (#1005)\n\nbody", files: [] },
      waivers: [],
      registries: {},
    }),
  ],
  invalid: [
    {
      code: withCommit("bad subject"),
      errors: [{ message: /is not a Conventional Commit subject/u }],
    },
    {
      code: withCommit("feat(governance): no issue reference here"),
      errors: [{ message: /ending in an issue reference/u }],
    },
    {
      code: withCommit("wibble(governance): an unknown type (#1005)"),
      errors: [{ message: /is not a Conventional Commit subject/u }],
    },
    {
      code: withCommit(long),
      errors: [{ message: `0123456789abcdef`.slice(0, 8) + ` — subject is ${long.length} chars (max 100)` }],
    },
    {
      // A waiver with no reason is not a waiver.
      code: withCommit("release 1.2.3", {
        waivers: [
          { directive: "commit-message-format", path: null, reason: "", source: "commit:0123456789abcdef" },
        ],
      }),
      errors: 1,
    },
    {
      code: JSON.stringify({
        schema: 2,
        commits: [],
        pending: { message: "# a comment\n\nbad pending subject\n", files: [] },
        waivers: [],
        registries: {},
      }),
      errors: [{ message: /^pending commit — 'bad pending subject'/u }],
    },
  ],
});
