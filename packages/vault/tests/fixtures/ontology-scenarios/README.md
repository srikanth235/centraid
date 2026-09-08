# The ontology scenarios

The thirteen scenarios [#996](https://github.com/srikanth235/centraid/issues/996) was opened over, as a **scripted fixture**: a builder that runs the real commands and the real import path against a fresh vault, on a clock and an id sequence that repeat, and hands back every claim already read through the path a surface reads it through.

```ts
import { buildOntologyScenarios } from "@centraid/vault/tests/ontology-scenarios";

const fixture = buildOntologyScenarios();
try {
  for (const scenario of fixture.scenarios)
    for (const check of scenario.checks)
      expect(check.actual).toStrictEqual(check.expected);
} finally {
  fixture.db.close();
}
```

The claims travel as data so the run can be asserted from **another package** without that test knowing anything of the vault's internals — which is what W1's convergence run replays. `fixture.db` is the vault every scenario ran against; the caller closes it.

## Why a fixture and not thirteen tests

Each of these findings was closed by a storage ruling that its readers then ignored, so the register's own rule is that **a storage ruling is not enforced until a reader test holds it**. A scenario is therefore a command→query round trip, and it names the two app surfaces the round trip crosses: a reader that ignores a stored column is red here, and red again wherever the fixture is replayed.

## The thirteen

| # | Scenario | Reproduces | Surfaces crossed |
| --- | --- | --- | --- |
| 1 | An end-dated primary does not block its replacement | ONT-30 | Contacts — the person's identifiers · Atlas — the row editor |
| 2 | The same short handle in two issuers is two identities | ONT-30 | Contacts — the person's identifiers · Social — identity resolution |
| 3 | 猫, 犬, कुत्ता and बिल्ली are four concepts | ONT-29 | Photos — the tag row · Search — tag filters |
| 4 | Bank A and Bank B may both import `ref-1` | ONT-24 | Tally — the ledger · Finance — the import review |
| 5 | Two documents with identical bytes keep separate histories | ONT-22 | Docs — the version history · Docs — restore |
| 6 | One byte row, two documents, two readings | ONT-28 | Docs — the document body · Photos — the asset's reading |
| 7 | Create, skip day two, query — under five readings of one wall clock | ONT-25 | Agenda (web) — upcoming · Agenda (phone) — the day list |
| 8 | Completing from People and then from Tasks is one completion | ONT-27 | People — the person's tasks · Tasks — the list |
| 9 | A recurring person task rolls over once, and keeps its links | ONT-27 | People — the person's tasks · Tasks — the recurring series |
| 10 | The same impossible task, refused by the command and by the row editor | ONT-26 | Tasks — the editor · Atlas — the row editor |
| 11 | USD 100 + EUR 100 is two balances, and nothing is 200 | ONT-23 | Tally — the dashboard hero · Tally — the group ledger |
| 12 | Competing machine claims, and the owner's assertion above them | R22 | Photos — the tag row · Photos — why this tag |
| 13 | One purge, and each role behaves as its declaration says | R22 | People — delete a person · Photos — the library after |

Scenarios 1–6 are the identity findings wave 0b closed, 7–10 the behaviour findings of wave 0c, 11 the money finding of wave 0d, and 12–13 the evidence and erasure findings of wave 0e. The drift rows are in [`docs/vault-ontology.md`](../../../../../docs/vault-ontology.md); R22 is in [`docs/decisions.md`](../../../../../docs/decisions.md).

## One vault, one clock

All thirteen run against **one** vault, in the order above, because that is the harder case: a scenario that only holds in a vault containing nothing else is not telling the truth about the product. Two consequences a new scenario must respect — each series takes its own week (`schedule.propose_event` refuses a busy overlap), and every read narrows to the rows its own scenario wrote.

The clock is the vault's clock. There is no seam to inject one, so `installFixtureClock` holds the global `Date` still for the length of the build and releases it in a `finally`; scenarios that need a later instant **advance** it rather than naming an hour. Wave 0c's prelude removed a test that named one, and it was a time bomb.

`fixture.digest` is sha256 over the run with identifiers canonicalised to the order they first appear: ids minted by a command are reproducible (the gateway derives them from the scenario's seed and the mint order), while the bootstrap's own ids are UUIDv7 off the clock and have no seed.
