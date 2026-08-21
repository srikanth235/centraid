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
 * There are currently no named absences. #791 moved every accessibility cell
 * to a real Playwright or RNTL evidence owner; the static source contract is
 * still a fast PR tripwire, but no longer stands in for a runtime tree.
 */
export const EXPECTED_GREY = [];
