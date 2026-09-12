// Every commit subject is a Conventional Commit that names its issue (#1005).
//
// Ported from the vendored `governance-kit/audit` shell directive of the same
// name, whose behaviour it reproduces exactly: the same type list, the same
// 100-character ceiling, the same issue suffix, the same skips (merge, revert,
// autosquash, bot authors) and the same in-body waiver.
import config from "../commitlint.config.ts";
import { defineArrivalRule } from "../lib/rule.ts";
import type { Arrival } from "../lib/types.ts";

/**
 * The header regex the three configured rules add up to.
 *
 * @param {object} rules The commitlint-shaped rule map.
 * @returns {RegExp} The matcher for a whole subject line.
 */
export function headerRegExp(rules: Record<string, unknown>) {
  const types = rules["type-enum"][2].join("|");
  const issue = rules["issue-ref"][2];
  return new RegExp(`^(?:${types})(?:\\([^)]+\\))?!?: .+ ${issue}$`, "u");
}

/**
 * Is this subject one the directive never judged?
 *
 * @param {string} subject The first line.
 * @returns {boolean} True when it is skipped.
 */
export function isIgnoredSubject(subject: string) {
  return config.ignores.some((pattern) => new RegExp(pattern, "u").test(subject));
}

export default defineArrivalRule({
  id: "commit-message-format",
  statute: "#commit-message-format",
  door: "hook",
  description: "Commit subjects follow Conventional Commits and end with the issue they answer.",
  // The pack row carries this rule's configuration; the shape is the pack's
  // business, so the schema is permissive and the rule reads what it knows.
  schema: [{ type: "object", additionalProperties: true }],
  enforces:
    "a commit whose subject is unparseable, over-long, or missing its issue reference cannot be made",
  check(arrival, ctx) {
    const rules = { ...config.rules, ...(ctx.options.rules as object | undefined) };
    const header = headerRegExp(rules);
    const maxLength = rules["header-max-length"][2];

    /**
     * Judge one subject.
     *
     * @param {string} subject The subject line.
     * @param {string} source The waiver source key for this message.
     * @param {(string|number)[]} pointer Where to report.
     * @param {string} label How to name it in the message.
     * @returns {void}
     */
    const judge = (subject, source, pointer, label) => {
      if (!subject || isIgnoredSubject(subject)) return;
      // The waiver lives in the body of the same message, because the subject
      // is what is being judged.
      const waived = arrival.waivers.some(
        (waiver) =>
          waiver.directive === "commit-message-format" &&
          waiver.reason !== "" &&
          waiver.source === source
      );
      if (waived) return;
      if (!header.test(subject)) {
        ctx.report(
          pointer,
          `${label} — '${subject}' is not a Conventional Commit subject ending in an issue reference (<type>(scope)?: <subject> (#123))`
        );
        return;
      }
      if (subject.length > maxLength) {
        ctx.report(pointer, `${label} — subject is ${subject.length} chars (max ${maxLength})`);
      }
    };

    for (const [index, commit] of arrival.commits.entries()) {
      // A bot's commit is judged by whoever wrote the bot.
      if (config.ignoreAuthors.some((needle) => (commit.authorEmail ?? "").includes(needle))) {
        continue;
      }
      judge(
        commit.subject,
        `commit:${commit.sha}`,
        ["commits", index, "subject"],
        commit.sha.slice(0, 8)
      );
    }
    if (arrival.pending) {
      const subject = arrival.pending.message
        .split("\n")
        .find((line) => line.trim() !== "" && !line.startsWith("#"));
      judge(subject ?? "", "pending", ["pending", "message"], "pending commit");
    }
  },
});
