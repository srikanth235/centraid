# Issue #807 — generic enrichment system (capability / engine / policy / consent) + Settings consolidation

GitHub issue: [#807](https://github.com/srikanth235/centraid/issues/807)

Umbrella receipt. Waves land as PR waves under this one issue; each wave appends
to the sections below rather than opening a receipt of its own.

## Checklist

- [x] Wave 0 — schema and contracts

## What changed

**Wave 0 — schema and contracts.** `enrich_derivation` gained a `profile` dimension (default
`built-in`) and its uniqueness widened to
`(target_type, target_id, variant, profile)`, so several engine profiles' results
for one variant coexist; `preferredDerivation` is the single resolution helper
every consumer reads through (issue Q5), and `stampedModel` resolves through it.
Two new vault tables land ahead of the waves that consume them:
`enrich_policy_rule` (the scoped cascade's rule store — vault | domain |
collection | item, per capability, `NULL` meaning inherit) and `enrich_consent`
(capability × egress class × optional scope, with a journal receipt pointer).
Both are registered in `schema/tables.ts`, so the canonical export walk and the
replica change log carry them. `packages/server/src/enrich/capability-registry.ts`
formalizes the nine shipped capabilities as versioned contracts.
The backfill story is unchanged by the keying: the backfill selector
(`idx_enrich_derivation_model`, capability + model) is profile-agnostic, so a
model/version bump re-arms exactly the rows behind it within each profile —
re-enrichment stays backfill, never destructive. `schema/poly-refs.ts` records
`enrich_policy_rule` in `POLY_REF_EXCLUSIONS`: its (scope_type, scope_ref) is a
cascade level, not the polymorphic entity shape, so rules are not swept on
purge — a rule whose collection is gone matches nothing and is inert.

## Decisions

#807 Wave 0 registers two new enrichment tables (enrich.policy_rule, enrich.consent) in schema/tables.ts, and the Atlas census counts one row-count query per REGISTERED table: the measured SQL baseline rises 138 -> 140, with no additional HTTP request and no new query per table beyond that count. Registration is what carries both tables through portable export and the replica change log, so the two statements are the price of them being real vault rows rather than a side store. Prior: #731 Atlas now counts the registered Commons control tables during its bounded first-paint census; the measured SQL baseline rises from 128 to 138 with no additional HTTP request.

#807 Wave 0: enrich_derivation gains a `profile` column and widens its UNIQUE key to (target_type, target_id, variant, profile) so plural engine results coexist; enrich_policy_rule (scoped policy cascade) and enrich_consent (capability x egress class) are new tables, both registered in schema/tables.ts so the canonical walk carries them. Export completeness re-audited in packages/vault/src/gateway/portable-export.ts: the new tables are owner decisions that must survive restore (a dropped consent row re-asks an answered question, or loses a recorded refusal), and the widened stamp key rides an already-walked table. No adapter, no content bytes, no table dropped.

**Rule fields are nullable.** `enrich_policy_rule.enabled`, `.profile` and
`.trigger_on` are each nullable and mean INHERIT, with a CHECK refusing a row
that decides nothing. The issue lists the three as a rule's contents; making
them mandatory would have forced every scope to restate decisions it does not
own, which is the opposite of a cascade.

**No resolver in Wave 0.** `enrich/policy-rules.ts` and
`enrich/egress-consent.ts` are storage only — no `mayThisRun`. Wave 2 grows
`decideEnrichmentGate` into the resolver; a storage-level answer would be the
second policy path the umbrella forbids.

**Schema evolution.** No migration rung and no table rebuild: `schema/enrich.ts`
is the pre-release, single-rung, edit-in-place base (`schema/migrate.ts`), where
a file written by an older shape is re-created rather than migrated. The
`profile` DEFAULT is what keeps every existing stamp call site byte-identical.

## Out of scope

Waves 1–6 (engine profiles, policy cascade + gate resolver, consent re-keying,
Settings consolidation, delegate expansions, mobile projection) land as later
waves under this same receipt. Provider-cost ceilings (issue Q7), a `tally`
domain (Q1), functional blueprint settings (Q2), and delegate engines for faces
(Q3) are out of scope per the issue's rulings. The legacy `EnrichTier` mirror
stays authoritative until the Wave 2 resolver absorbs it.

## Verification

```sh
bun run --cwd packages/vault test           # 173 files, 1310 passed, 2 skipped
bunx turbo run typecheck --filter=@centraid/vault --filter=@centraid/server  # 19/19
bun run --cwd packages/server test -- capability-registry  # 6 passed
bun run lint                                # clean
bun run lint:schema-export                  # ratchet green
bun run test:qualities                      # 24 passed
bun run format:check                        # clean
```

## Audit

Fresh-context adversarial sub-agent, handed the diff, this receipt, and issue
#807's Wave 0 scope; instructed to default to REFUTED.

1. `## What changed` faithfully describes the diff — **PASS** (re-verified the
   widened UNIQUE key, `preferredDerivation` fallback order, both new tables'
   DDL, `schema/tables.ts` registration, and that no UI files changed).
2. Each `- [x]` item is realized in the diff — **PASS** (re-ran vault
   derivation/policy-rules/egress-consent tests, 26 passed, and
   capability-registry, 6 passed).
3. Checklist mirrors the issue's Wave 0 plan — **PASS** (Q1 keeps
   `EnrichDomain` closed, so "opened per Q1" resolves to a deliberate no-op;
   the policy-rule and consent tables land ahead of Waves 2–3 by the
   single-schema-owner decision, disclosed above).

Auditor's minor findings (backfill story and the poly-refs exclusion were
unnarrated) were folded into `## What changed` after the audit.

## Files

- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/policy-rules.ts`
- `packages/vault/src/enrich/policy-rules.test.ts`
- `packages/vault/src/enrich/egress-consent.ts`
- `packages/vault/src/enrich/egress-consent.test.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/index.ts`
- `packages/server/src/enrich/capability-registry.ts`
- `packages/server/src/enrich/capability-registry.test.ts`
- `tests/schema-export-fingerprint.json`
- `tests/experience-budgets/client-query-counts.json`
- `docs/photos/derived-ledger.md`
- `docs/decisions.md`

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-16 | claude-code | 97726ea0-2cc1-5450-a046-cac6be0b3d6a |
