// One receipt per issue, and a completed change is associated with one (#1005).
//
// Ported from the vendored `governance-kit/audit` shell directive of the same
// name. Always: the filename shape and one receipt per issue number. At the
// completed-change boundary: the change set must touch a receipt, and a
// non-stub receipt the change ADDS needs `## What changed`, a `## Verification`
// that records an outcome and not only a fence, and a `## Audit` carrying a
// PASS or REFUTED verdict.
//
// The verdict itself is not this rule's to give. A mechanical check can see
// that the section exists and names a verdict; whether the verdict is true is
// an independent judgement, which is why the message says so and why the
// author of the change is not the one who writes it.
import { defineArrivalRule } from "../lib/rule.mjs";

/** Sections a completed-change receipt must carry. */
const COMPLETED_SECTIONS = ["What changed", "Verification"];

/** `issue-<N>.md`, or `issue-<N>-<kebab-slug>.md`. */
const FILENAME = /^issue-(?<number>[0-9]+)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/u;

export default defineArrivalRule({
  id: "receipt-per-issue",
  statute: "#receipt-per-issue",
  door: "window",
  description: "Every issue has exactly one well-formed receipt, and a completed change carries it.",
  enforces: "a duplicate or misnamed receipt, and a completed change with no receipt at all",
  observes:
    "whether the receipt's Audit verdict is true — that is an independent judgement a rule cannot make",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const sections = ctx.options.completedSections ?? COMPLETED_SECTIONS;
    const registry = arrival.registries?.receipts;
    if (!registry) return;
    const { files, change } = registry;

    // A waiver in any non-merge, non-revert commit of the range (or in the
    // pending message) excuses the whole change set from carrying a receipt.
    const commitBySha = new Map(arrival.commits.map((commit) => [commit.sha, commit]));
    const rangeWaived = arrival.waivers.some((waiver) => {
      if (waiver.directive !== "receipt-per-issue" || waiver.reason === "") return false;
      if (waiver.source === "pending") return true;
      const commit = commitBySha.get(waiver.source.slice("commit:".length));
      if (!commit) return false;
      return commit.parents.length <= 1 && !commit.subject.startsWith('Revert "');
    });

    if (change.completedChange && !change.touchesReceipt && !rangeWaived) {
      ctx.report(
        ["registries", "receipts", "change", "touchesReceipt"],
        "completed change touches no receipts/issue-*.md (intermediate commits need not each edit a receipt; the aggregate must. Waiver: 'governance: allow-receipt-per-issue <reason>')"
      );
    }

    const seen = new Map();
    for (const [index, receipt] of files.entries()) {
      if (receipt.fileWaiver) continue;
      const at = ["registries", "receipts", "files", index];
      const match = FILENAME.exec(receipt.name);
      if (!match) {
        ctx.report(
          at,
          `${receipt.path} — receipt filename must match 'issue-<N>.md' or optional 'issue-<N>-<slug>.md' (kebab-case slug)`
        );
      } else if (seen.has(match.groups.number)) {
        ctx.report(
          at,
          `${receipt.path} — issue #${match.groups.number} already has a receipt at ${seen.get(match.groups.number)}`
        );
      } else {
        seen.set(match.groups.number, receipt.path);
      }

      // Shape is demanded only of a receipt this change ADDS, at the completed
      // -change boundary: an intermediate commit may carry a stub, and a
      // receipt somebody else wrote is not this change's to fix.
      if (!change.completedChange) continue;
      if (!receipt.addedInRange && !receipt.addedInPending) continue;

      if (receipt.stub) {
        ctx.report(
          at,
          `${receipt.path} — session-only receipt stub cannot satisfy a completed change; add ## What changed and ## Verification evidence (a stub is valid on intermediate commits only)`
        );
        continue;
      }
      for (const section of sections) {
        if (!receipt.headings.includes(section)) {
          ctx.report(at, `${receipt.path} — completed-change receipt is missing a '## ${section}' section`);
        }
      }
      if (receipt.headings.includes("Verification")) {
        const { hasFence, hasOutcome, hasUrl } = receipt.verification;
        if (!hasUrl && !(hasFence && hasOutcome)) {
          ctx.report(
            at,
            `${receipt.path} — ## Verification must record a command and its outcome (fence + pass/fail/exit) or a durable evidence URL; a fence alone is not evidence. This check does not prove the command ran.`
          );
        }
      }
      if (!receipt.headings.includes("Audit")) {
        ctx.report(
          at,
          `${receipt.path} — missing a '## Audit' section. Mechanical checks record that outcome and verification text exist; they do not prove the receipt matches the diff or that a command ran.`
        );
      } else if (!receipt.audit.hasVerdict) {
        ctx.report(
          at,
          `${receipt.path} — '## Audit' records no PASS/REFUTED verdict; an independent reviewer must report a verdict + evidence for each check this rule names.`
        );
      }
    }
  },
});
