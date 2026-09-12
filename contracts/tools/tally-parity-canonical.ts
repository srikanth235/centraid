// CANONICALISATION — the one place a fixture decides what is a FACT and what is
// an artifact of the run that wrote it (#1020, wave 2 lane D3; wave 4 lane
// Tally-finish).
//
// Three classes of value are not facts about the ledger and are replaced:
//
//   * an IDENTIFIER, because a uuid the bootstrap minted is not reproducible;
//   * a HOST-CLOCK INSTANT, because `updated_at` comes from SQLite's own clock
//     and no injected clock reaches it;
//   * an ID-DERIVED PARTY HUE, because the hue hashes an id this pass has just
//     rewritten.
//
// It lives in its own file because `export-tally-parity.ts` is the RUN and this
// is the ledger's own definition of sameness; the two change for different
// reasons, and the emitter is at its line ceiling besides.

/**
 * The token every host-clock instant is replaced by.
 *
 * THE SECOND HALF OF THE TWO-CLOCKS FINDING (see [`PARITY_EPOCH` in `export-tally-parity.ts`]). Every
 * replicated table carries `updated_at TEXT NOT NULL DEFAULT
 * (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` and a trigger that re-stamps it the
 * same way (`packages/vault/src/schema/updated-at.ts:2`, `:8-16`). That is
 * SQLite's clock, which no JS proxy reaches, so `updated_at` is the wall time
 * of whoever regenerated the fixture and can never be committed as a value.
 * Replacing it with a token says exactly that, and keeps the column's PRESENCE
 * — which is what a port has to reproduce — while dropping a value that is not
 * a fact about the ledger. `crates/vault` taking its instant from one injected
 * source removes both halves of this.
 */
const HOST_CLOCK = "<host-clock>";

/**
 * ONE ID SPACE PER VAULT (#1020, wave 4 lane Tally-finish).
 *
 * THE BUG THIS FIXES, and it made the fixture uncomparable. `canonicalise` held
 * its `seen` map in its own body, so each call started numbering at `id-0001`
 * — and it was called once for `rows` and once for `queries`. The same expense
 * was therefore `id-0035` in `rows.json` and `id-0016` in `queries.json`, and
 * `export`'s own inputs named group ids that no row in `rows.json` carried. A
 * port that rebuilds the vault from the rows and runs the queries could not
 * compare a single case: every id disagreed, and the disagreement was an
 * artifact of the generator rather than a fact about either side.
 *
 * The map is now created once per VAULT and shared by every artifact read out
 * of it. The ontology scenarios get their own, because they are built from a
 * DIFFERENT vault (`buildOntologyScenarios`) and sharing a numbering across two
 * vaults would assert a relationship that does not exist.
 */
export function canonicaliser(): <T>(value: T) => T {
  const seen = new Map<string, string>();
  return <T>(value: T): T => canonicaliseWith(value, seen);
}

/**
 * Canonicalise every identifier, every host-clock instant and every id-derived
 * party hue.
 *
 * Two id shapes reach a fixture: UUIDv7 from the bootstrap (not seed-derived)
 * and the command-minted ids, which ARE seed-derived and reproducible. Both are
 * canonicalised anyway, because a fixture that is stable only for half its ids
 * is a fixture whose diff nobody trusts.
 *
 * ## The tokens are assigned in the ids' OWN SORT ORDER (#1020, wave 4)
 *
 * They used to be assigned in order of first appearance, which silently broke
 * every claim an output makes about ORDER. `tally.dashboard.groups` reads
 * `ORDER BY group_id`, so the dashboard's three groups came back in the real
 * uuids' order — and the tokens those uuids were rewritten to sorted the other
 * way, because one of the groups happened to appear earlier in the bundle. A
 * port that rebuilds the vault from `rows.json` and sorts by `group_id` reads
 * the canonical order, which disagreed with the committed answer for a reason
 * that is nothing to do with either implementation. Sorting the ids before
 * numbering them makes `ORDER BY <id>` mean the same thing on both sides, which
 * is what "the same rows, in the same order" has to mean for a fixture.
 *
 * ## A party hue is MASKED, for the same reason `updated_at` is
 *
 * `partyHueValue(partyHueKey(id))` hashes the party id, so the answer is about
 * the id the vault minted — and this function has just rewritten that id. The
 * committed value would therefore be an answer no reader can reproduce and no
 * port can be wrong about; keeping it would make every ledger row in the
 * fixture a false claim. It is replaced by a token, exactly as a host-clock
 * instant is, and the hue wheel is proven where its inputs ARE stable:
 * `design/identity-corpus.json`, 192 rows of literal ids, asserted by
 * `crates/design` (#1020, D-1020-T1). The OWNER's colour is the ink brand and
 * is not id-derived, so it survives as itself — which is the distinction a
 * surface actually turns on.
 */
const PARTY_HUE = "<party-hue>";

function canonicaliseWith<T>(value: T, seen: Map<string, string>): T {
  const ID =
    /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/giu;
  // Any instant outside the frozen run's own year. The run is stamped in 2099
  // precisely so that "not ours" is decidable by inspection rather than by a
  // range check nobody can read.
  const HOST_INSTANT =
    /(?<!2099)\b(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
  // A hue the person wheel produced, and never a stored `color` column: those
  // are hexes (`tally_group.color`) and are facts about the row.
  const ID_DERIVED_HUE = /var\(--c-[a-z]+\)/gu;
  const source = JSON.stringify(value);
  // FIRST PASS: learn every id, and number them in their own order.
  const unseen = [
    ...new Set([...source.matchAll(ID)].map((match) => match[0].toLowerCase())),
  ]
    .filter((id) => !seen.has(id))
    .sort();
  for (const id of unseen) {
    seen.set(id, `id-${String(seen.size + 1).padStart(4, "0")}`);
  }
  const text = source
    .replaceAll(ID, (id) => seen.get(id.toLowerCase()) ?? id)
    .replaceAll(HOST_INSTANT, HOST_CLOCK)
    .replaceAll(ID_DERIVED_HUE, PARTY_HUE);
  return JSON.parse(text) as T;
}
