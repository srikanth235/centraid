# #1119 — Money closes its three known gaps

This change closes the gaps that #1099 recorded and #1112 shipped with. R-1099-47 is superseded by R-1119-1, and R-1099-68 by R-1119-2. The work ran in two lanes: lane R (the vault, Agenda's import and Money's detection) and lane U (the phone's editors). The root merged both and fixed two clippy reds left by #1112.

## What changed

- **The vault's recurrence subset** (`crates/vault/src/time/{rrule,recurrence,zone,mod}.rs`):
  - `FREQ=MONTHLY` takes exactly one of: one positional `BYDAY` (`1`..`4` or `-1` with a day), or one `BYMONTHDAY` (`1`..`31` or `-1`). It is held as `ParsedRrule.monthly_pin` (`MonthlyPin::{NthWeekday, MonthDay}`).
  - A month that lacks the day is skipped, per RFC 5545, and COUNT counts occurrences.
  - Every other form stays refused: BYSETPOS, a day list or a plain day on MONTHLY, BYMONTHDAY outside MONTHLY or as a list, BYDAY beside BYMONTHDAY, and `5MO`.
  - `describe` says "Monthly on the second Monday", "Monthly on the last day", "Monthly on the 15th" and "Every other month on …".
  - There is still one expander (R-1099-36).
- **Refusal sentences.** v0's `BYDAY` sentence said a positional day could never be honoured. v0's `BYMONTHDAY` sentence said the expander only steps from the anchor day. Both are now false for a MONTHLY rule, so both are rewritten.
  - The frozen golden `contracts/time/rrule-cases.json` is not rewritten. `time_corpus.rs::REWORDED_1119` holds v0's two sentences, asserts that the golden still says them, and asserts that this build's sentence differs and names MONTHLY.
  - `WIDENED_1119` lists the five golden cases v0 refused that this build accepts, each with its pin and sentence. `contracts/time/README.md` records both departures.
- **Consumers.**
  - `crates/apps/agenda/tests/monthly_positions.rs` expands the new rules through `expand_recurring_events` in America/Los_Angeles.
  - `schedule_commands.rs` stores the accepted forms and refuses a `BYMONTHDAY` list and `5MO`.
  - `CalendarImport.kt` keeps a monthly `BYMONTHDAY` rather than stripping it, so the import accepts what the vault accepts. `CalendarImportRuleSpec` has 5 tests.
- **Money's recurring detection** (`crates/apps/money/src/recurring.rs`):
  - It offers the nth weekday, the last weekday and the month's end (the last day, or the last business day within ±2 days). All of them go out as `Cadence::Monthly`, so the proto enum is unchanged.
  - A position must match in every month between its first and last match, and the anchor must itself match. Without this rule, the existing case "a monthly charge may drift two days" (four charges, three days off) was read as a 3rd Saturday. That test is unchanged.
  - `contracts/apps/money/recurring.json` gains hand-computed `positions` and `not_offered` blocks.
- **Phone: accounts** (`MoneyAccounts.kt`, `screen.proto` additive, `copy/money.json` and its `MoneyCopy.kt` twin, 13 keys):
  - "Remove bank number" is offered only when the account has one. It asks first, then sends `money.edit_account {account_id, external_ref: null}` and nothing else.
  - The masked last four digits are never put in the field or sent.
- **Phone: rules** (`MoneyRules.kt`):
  - Every edit sends `amount_min_minor`, `amount_max_minor` and `account_id`. A cleared field sends `null`, and an untouched field sends its current value.
  - A minimum above the maximum is refused with its own sentence.
  - The rule's account is found by its exact stored name, which both answers carry and which the vault's commands keep unique per vault. The amount's exponent is read off the accounts answer, never guessed. A case-blind match was replaced after the audit (below).
  - When no single exponent is known, the limit fields lock and the stored limits go back unchanged. Picking an account unlocks them.
  - Adding a rule takes limits and an account too.
- **Views:**
  - Android: `screens/money/MoneyPages.kt`.
  - iOS: `Sources/Money/MoneyManageViews.swift`.
  - Neither was compiled here (no Android SDK, no Xcode). Both join the existing Money hand-off, row 1.8 of `docs/release/v1-handoffs.md`.
- **Two clippy reds left by #1112:**
  - Five Money screen states (`MoneyHome`, `MoneyTransaction`, `MoneyTarget`, `MoneyImport`, `MoneyCategories`) tripped `large_enum_variant` in the generated `centraid-api-proto`. Their `content.data` arms are now boxed in `crates/api-proto/build.rs`, as every other app screen's are. No Rust code builds these states.
  - `phase9_nt9b.rs` kept a `vault_of` helper whose only caller was a Tally test. It is removed.
  - `crates/core/tests/assist_door.rs` is `cargo fmt`-clean again.

## Verification

Red first:
- **Vault.** With `monthly_pin` stubbed, `cargo test -p centraid-vault --lib time::` gave 46 passed and 13 failed. With the change it gives 60 passed.
- **Money.** With the position shapes disabled, the month-position tests gave 8 failed and 13 passed.
- **Agenda.** Run against the old `time/`, `monthly_positions` gave 2 failed and 1 passed (the refusal case).
- **Kotlin.** With the old strip restored, `CalendarImportRuleSpec` gave 5 run and 1 failed.

```sh
cargo test -p centraid-vault --test time_corpus
```

Outcome: pass, 14 tests. The same test run against v0's sentences failed: `rrule "FREQ=DAILY;BYMONTHDAY=-1": #1119 rewrote this sentence`.

```sh
cargo test -p centraid-vault -p centraid-apps-agenda -p centraid-apps-tasks -p centraid-apps-money -p centraid-core --all-features
```

Outcome: pass, with no failed target.

```sh
cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo fmt --all --check
```

Outcome: pass, exit 0 for both. On origin/main both were red: api-proto `large_enum_variant` ×5, `phase9_nt9b` `vault_of` unused, and `assist_door.rs` formatting.

```sh
cd mobile && ./gradlew :shared:jvmTest
```

Outcome: pass, 1,355 tests and 0 failed in lane R; MoneyScreensSpec with 29 tests in lane U.

```sh
cargo xtask gate --profile mobile-jvm
```

Outcome: lane U passed in 72.3 s on a warm tree. Its first, cold run had every step green but took 935 s against the 420 s budget, on a box shared with other lanes. The budget was not touched.

```sh
cargo xtask rules && bun run check:push:static && bun run lint:copy
```

Outcome: all pass, 4/4 static gates.

## Audit

**PASS.** An independent Sonnet auditor checked the branch at `dc6ad3a36` against this receipt. It worked read-only and wrote none of the change. Its probes ran on a `git archive` copy outside the tree.

- **The widening is correct and narrow: PASS.**
  - BYMONTHDAY=31 over 2024 gives Jan, Mar, May, Jul, Aug, Oct and Dec only. BYMONTHDAY=-1 gives Feb 29. `-1FR`, `4SU`, `1TH`, COUNT, UNTIL and INTERVAL=2 are correct.
  - Still refused, each naming the right part: BYSETPOS, a MONTHLY BYDAY list, plain `MO` on MONTHLY, BYMONTHDAY on WEEKLY/DAILY/YEARLY, a BYMONTHDAY list, BYDAY with BYMONTHDAY, `5MO`, `-2MO`, and YEARLY with BYDAY.
  - `cargo test -p centraid-vault --lib time::`: 60 passed.
  - Nits, left as they are: `+5`, `05`, `02MO` and lowercase `2mo` are also accepted, all unambiguous. A positional day that falls before the anchor in the anchor's month starts at the next match.
- **The golden is untouched: PASS.**
  - `rrule-cases.json` has no diff.
  - `WIDENED_1119` asserts that each of its five rules is a v0 refusal. `REWORDED_1119` asserts that the golden keeps v0's two sentences.
  - Every other case still compares exactly, and the new sentences are true.
- **Money detection: PASS.**
  - The test diff is additive. The drift test is untouched.
  - One unit test was inverted on purpose: R-1099-47's "not offered" became "offered as a month position". That is the superseded behaviour.
- **CalendarImport.kt: PASS.** It now keeps a MONTHLY `BYMONTHDAY` and changes nothing else.
- **Phone editors: PASS, with one caveat, now fixed.**
  - Removing the bank number sends exactly `{account_id, external_ref: null}`.
  - A cleared rule field sends null, an untouched one its value, min > max is refused, and locked limits are left unchanged.
  - The caveat: the case-blind name match (`equals(ignoreCase = true)`) could disagree with SQLite's ASCII-only `lower()` on a non-ASCII name. The match is now exact; both answers carry the stored name. `:shared:jvmTest` passes after the change.
- **No weakened tests: PASS.** Each test change reflects intended new behaviour: `schedule_commands.rs` refuses a list rather than `BYMONTHDAY=1`, and the one inverted unit test above. No assertion was loosened.
- **Clippy fixes: PASS.** No Rust code references the five boxed Money states, and `vault_of` had no caller.
- **The receipt's counts match: PASS.** That is 5 widened rules, 13 copy keys, 5 CalendarImport specs, 29 MoneyScreensSpec tests, 14 corpus tests and 60 vault time tests.
- The auditor did not re-run Gradle, the `mobile-jvm` gate or workspace clippy; the outcomes above are the lanes' and the root's.
