/**
 * Named, budgeted absences for the nightly zero-grey contract (#781).
 *
 * A matrix cell whose declared owner has NO evidence lane at all cannot go
 * green, red, or grey honestly — there is nothing that could ever emit
 * evidence for it, so rendering it as red noise every night teaches people to
 * ignore the report. Each registration here names the missing lane, the cells
 * it would feed, the owner that stands in for it today, and the tracking
 * issue for building the lane.
 *
 * This list is a BUDGET, not an allowlist:
 *
 * - A cell is exempt only while the named lane has never run (no lane-start
 *   marker) and the owner produced no evidence. The moment the lane exists —
 *   e.g. #781's accessibility-lane slice writes a `prepare.mjs --lane
 *   accessibility` marker — the registration is void at runtime and a grey
 *   cell goes red again, with no edit here required.
 * - A cell NOT enumerated here that goes grey still fails the nightly
 *   zero-grey contract. Adding a cell to this list is a reviewed edit that
 *   must cite an open issue.
 * - Real evidence (pass or fail) always wins over the exemption: only the
 *   no-evidence states (`missing`, `owner-silent`, `lane-did-not-run`) can be
 *   reclassified as expected-grey.
 *
 * The single current registration: the 15 `*:accessibility` cells. Their
 * declared owner, `scripts/accessibility-contract.test.mjs`, is a per-PR
 * `node --test` gate (`bun run test:accessibility` inside `check:push`) that
 * writes no evidence artifact and never appears in the nightly Vitest JSON,
 * so every nightly since 2026-08-01 red-flagged the same 15 cells
 * (`nightly zero-grey contract: 15 cell(s) have no evidence` +
 * `declared owner produced no evidence key`) without any of that red being
 * actionable. The accessibility lane itself is tracked under #781
 * (accepted as a follow-up lane in #587 D21).
 */
export const EXPECTED_GREY = [
  {
    lane: "accessibility",
    issue: "https://github.com/srikanth235/centraid/issues/781",
    reason:
      "scripts/accessibility-contract.test.mjs is a per-PR node --test gate with no evidence artifact; the accessibility evidence lane does not exist yet (#587 D21 follow-up, tracked by #781).",
    owner: "scripts/accessibility-contract.test.mjs",
    cells: [
      "vault-core:accessibility",
      "blob-custody:accessibility",
      "backup-restore:accessibility",
      "replica-sync:accessibility",
      "gateway:accessibility",
      "app-engine:accessibility",
      "automations:accessibility",
      "agent-runtime:accessibility",
      "blueprints:accessibility",
      "desktop:accessibility",
      "web:accessibility",
      "mobile:accessibility",
      "tunnel-pairing:accessibility",
      "extension:accessibility",
      "oauth-worker:accessibility",
    ],
  },
];
