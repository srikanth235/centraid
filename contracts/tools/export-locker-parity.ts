// Export Locker's parity fixtures from the v0 tree (#1020, wave 4 lane Locker,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, writes a corpus through the REAL typed `locker.*` commands, then
// invokes all eight Locker queries through the real handler path — the same
// statement-as-data through the same paged door — and writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/locker/`:
//
//   rows.json       every row of every table the eight queries read, by table
//   queries.json    {query, input, output, why} for all eight, at fixed inputs
//   commands.json   {command, input, status, output} for the 22 `locker.*` cases
//   manifest.json   what the bundle is, and whether it has been generated
//
// ============================================================================
// THIS FILE IS COMMITTED AND HAS NOT BEEN RUN. Read this before trusting it.
// ============================================================================
//
// The lane that wrote it had **3.6 GB of disk free** (`df -h /home/user`) with
// three Rust lanes sharing one box, and `bun install` in this worktree needs
// ~2.6 GB on its own. Running it would have taken the disk to under a
// gigabyte with two other lanes still building, which breaks THEM — and a lane
// that fills a shared disk to produce its own fixture has traded somebody
// else's work for its own. Photos' generator is committed unrun for the same
// reason and says so in the same place.
//
// So this is committed unrun, `contracts/apps/locker/manifest.json` declares
// `fixtures: "pending-regeneration"`, and
// `crates/apps/locker/tests/parity.rs` ASSERTS that declaration — a green Rust
// suite therefore cannot be read as parity.
//
// What the owner has to run, in a worktree with disk:
//
//   bun install && bun run build
//   bun contracts/tools/export-locker-parity.ts
//   bun run format && git diff --exit-code contracts/apps/locker
//   node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts \
//     tests/quality/locker-parity.contract.test.ts
//
// The expected evidence: four JSON files appear under `contracts/apps/locker`,
// the second run of the same command writes nothing (`git diff --exit-code`
// passes), and the Rust side's `the_fixture_bundle_is_declared_pending…` test
// FAILS — which is the signal to replace it with the comparison and drop
// `fixtures` from the manifest.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's and
// Photos' generators: `bootstrapVault` mints its ids as UUIDv7 off the clock,
// so a database file is not byte-reproducible; a compressed database is not
// reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// THREE THINGS THIS GENERATOR MUST DO THAT PHOTOS' DID NOT.
//
// 1. **IT HOLDS SECRETS, AND MUST NOT WRITE ONE DOWN.** Every sealed cell is
//    canonicalised to `«lk1»` and every key id to `«key»` — see
//    `locker-parity-bundle.ts`'s header for why, and note the direction of the
//    check: a sealed column holding a value that is NOT ciphertext makes the
//    generator **throw**, because a plaintext in a sealed column is the bug
//    this fixture exists to catch.
// 2. **The `access` query's rows are in the AUDIT BAND**, not the replica, so
//    the corpus has to make receipts happen — a reveal, an unlock, a fill,
//    and a deny — rather than inserting `access_receipt` rows. The query is
//    online-only for exactly this reason and a fixture that faked the rows
//    would not be testing it.
// 3. **The fixture must trip the two walls.** `queries/access.ts`'s own
//    predicate is the inner wall, so the corpus writes receipts for a
//    NON-Locker object type too — otherwise a port that dropped the predicate
//    would pass, and the census names that as the failure the wall exists for
//    (a busy vault's newest 200 receipts being entirely someone else's).

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerLockerCommands } from "../../packages/vault/src/commands/locker.js";
import { registerTagCommands } from "../../packages/vault/src/commands/tags.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import {
  LOCKER_PARITY_TABLES,
  PARITY_EPOCH,
  canonicaliseBundle,
  canonicaliseCell,
  plantLockerAccessReceipts,
} from "./locker-parity-bundle.js";
import type {
  CommandCase,
  LockerParityBundle,
  QueryCase,
} from "./locker-parity-bundle.js";
import { canonicaliser } from "./tally-parity-canonical.js";

export {
  DEK_SEALED_CELL,
  KEY_ID,
  LOCKER_PARITY_DIR,
  LOCKER_PARITY_TABLES,
  PARITY_EPOCH,
  SEALED_CELL,
  stableJson,
} from "./locker-parity-bundle.js";
export type {
  CommandCase,
  LockerParityBundle,
  QueryCase,
  TableRows,
} from "./locker-parity-bundle.js";

/** The eight query handlers, by the name their file carries. */
type Handlers = Record<string, (args: unknown) => Promise<unknown>>;

/**
 * Import the eight handlers.
 *
 * THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
 * records: a literal import pulls the whole blueprint handler graph into
 * whatever TypeScript program type-checks this file, and no program that can
 * also see `packages/vault/src` has both tsconfigs.
 */
async function loadHandlers(): Promise<Handlers> {
  const NAMES = [
    "items",
    "item",
    "search",
    "trash",
    "watchtower",
    "access",
    "autofill-candidates",
    "autofill-item",
  ] as const;
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/locker/queries/${name}.ts`)
    )
  );
  return Object.fromEntries(
    NAMES.map((name, index) => [
      name,
      (modules[index] as { default: unknown }).default as (
        args: unknown
      ) => Promise<unknown>,
    ])
  );
}

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildLockerParity(): Promise<LockerParityBundle> {
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  try {
    const boot = bootstrapVault(db, { ownerName: "Ada", baseCurrency: "GBP" });
    const gateway = createGateway(db);
    registerLockerCommands(gateway);
    // `star-item` and `unstar-item` write through the flags scheme, which the
    // tag commands bootstrap. Without them the star cases cannot run.
    registerTagCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    let step = 0;
    const commands: CommandCase[] = [];
    const execute = <T>(
      command: string,
      input: Record<string, unknown>,
      expect: "executed" | "any" = "executed"
    ): T => {
      const outcome = gateway.invoke(
        owner,
        { command, input },
        `locker-parity:${step++}`
      );
      const reason =
        (outcome as { reason?: string; message?: string }).reason ??
        (outcome as { message?: string }).message;
      // EVERY case is recorded, refusals included: a refusal is an answer the
      // port has to reproduce, and the ones this fixture trips on purpose —
      // a lapsed restore, a duplicate alias, a login-only policy on a note —
      // are the cases a port gets wrong.
      //
      // THE INPUT IS RECORDED WITH ITS SECRETS REMOVED. `sealedInput` keeps
      // them out of the journal; this keeps them out of the fixture, which is
      // a file in a repository and therefore the worse place.
      const sealedKeys = new Set([
        "password",
        "otp_seed",
        "card_number",
        "cvv",
        "content",
        "value",
        "private_key",
      ]);
      commands.push({
        command,
        input: Object.fromEntries(
          Object.entries(input).map(([key, value]) => [
            key,
            sealedKeys.has(key) && typeof value === "string"
              ? "«secret»"
              : value,
          ])
        ),
        status: outcome.status,
        output: (outcome as { output?: unknown }).output ?? null,
        ...(reason === undefined ? {} : { reason }),
      });
      if (expect === "executed" && outcome.status !== "executed") {
        throw new Error(
          `${command} answered ${outcome.status}: ${reason ?? "no reason given"}`
        );
      }
      // Time moves between commands, or two writes share an instant and every
      // ordering claim over them says nothing.
      clock.advance(1_000);
      return (outcome as { output?: T }).output as T;
    };

    // ---- THE CORPUS. Locker has NO demo seed (census §A0), which is why this
    // ---- is a scripted command set and not a seed run: a lane porting "every
    // ---- app's demo seed" finds seven, and Locker is the eighth.
    const bank = execute<{ item_id: string }>("locker.add_item", {
      type: "login",
      title: "The bank",
      username: "ada@example.com",
      url: "https://login.bank.example",
      url_match_policy: "registrable-domain",
      password: "correct-horse-battery-staple",
      otp_seed: "JBSWY3DPEHPK3PXP",
      notes: "the joint account",
      tags: ["money", "money"],
      alias: "bank",
    });
    const pinned = execute<{ item_id: string }>("locker.add_item", {
      type: "login",
      title: "The pinned login",
      username: "ada",
      url: "https://accounts.example.com",
      // EXACT-HOST, so the autofill cases can show the policy refusing a
      // sibling host. A fixture with only registrable-domain logins cannot.
      url_match_policy: "exact-host",
      password: "correct-horse-battery-staple",
    });
    const card = execute<{ item_id: string }>("locker.add_item", {
      type: "card",
      title: "The card",
      cardholder: "A Lovelace",
      card_number: "4242 4242 4242 4242",
      expiry: "2030-01",
      cvv: "123",
      brand: "visa",
    });
    const note = execute<{ item_id: string }>("locker.add_item", {
      type: "note",
      title: "A secure note",
      content: "the safe combination",
    });
    // A TEMPLATE-BACKED TYPE, which owns no columns of its own: the fixture
    // has to carry its minted `locker_item_field` rows or a port that never
    // mints them passes.
    const passport = execute<{ item_id: string }>("locker.add_item", {
      type: "passport",
      title: "Passport",
      notes: "in the drawer",
    });
    const wifi = execute<{ item_id: string }>("locker.add_item", {
      type: "wifi",
      title: "Home wifi",
      network: "Lovelace",
      password: "a-different-passphrase",
    });
    const archived = execute<{ item_id: string }>("locker.add_item", {
      type: "login",
      title: "An old login",
      username: "ada",
      url: "https://old.example",
      password: "short",
    });
    const trashed = execute<{ item_id: string }>("locker.add_item", {
      type: "login",
      title: "A trashed login",
      password: "correct-horse-battery-staple",
    });

    // A DUPLICATE ALIAS IS REFUSED, and the refusal is the answer.
    execute(
      "locker.edit_item",
      { item_id: pinned.item_id, alias: "bank" },
      "any"
    );
    // A login-only policy on a note is refused.
    execute(
      "locker.edit_item",
      { item_id: note.item_id, url_match_policy: "exact-host" },
      "any"
    );

    execute("locker.star_item", { item_id: bank.item_id });
    execute("locker.star_item", { item_id: card.item_id });
    execute("locker.unstar_item", { item_id: card.item_id });
    execute("locker.set_memo", {
      item_id: bank.item_id,
      note: "the joint account, not the ISA",
    });
    execute("locker.set_field", {
      item_id: bank.item_id,
      section: "Recovery",
      label: "Recovery code",
      kind: "sealed",
      value: "0000-1111-2222",
      position: 0,
    });
    execute("locker.set_field", {
      item_id: bank.item_id,
      section: "Recovery",
      label: "Branch",
      kind: "text",
      value: "Marylebone",
      position: 1,
    });
    execute("locker.set_addresses", {
      item_id: bank.item_id,
      addresses: [
        { url: "https://m.bank.example" },
        { url: "https://secure.bank.example", match_policy: "exact-host" },
        // A duplicate, deduplicated by position rather than refused.
        { url: "https://m.bank.example" },
      ],
    });
    execute("locker.set_passkey", {
      item_id: bank.item_id,
      rp_id: "bank.example",
      user_handle: "ada",
      display_name: "Ada",
      credential_id: "cred-1",
      algorithm: "ES256",
      private_key: "-----BEGIN PRIVATE KEY-----",
    });
    execute("locker.archive_item", { item_id: archived.item_id });
    execute("locker.trash_item", { item_id: trashed.item_id });
    // A RESTORE AND A RE-TRASH, so the fixture carries both lifecycles and the
    // revision chain the item pane's history reads.
    execute("locker.restore_item", { item_id: trashed.item_id });
    execute("locker.trash_item", { item_id: trashed.item_id });
    // AN EDIT REWRITES THE TYPE'S FIELDS AND DOES NOT PATCH THEM.
    //
    // v0's own test names it — *"edit_item rewrites the type fields and
    // replaces tags"* — and `fieldValues` is what makes it true: every column
    // of the type is written, `null` for the omitted ones. So the whole draft
    // goes on every edit, which is exactly what `editItemWrite` does
    // (`writes.ts`'s `itemPayload(draft, true)`). A partial edit here would
    // clear the seed the fixture is built on, and the generator caught that on
    // its first run.
    const bankDraft = {
      item_id: bank.item_id,
      username: "ada@example.com",
      url: "https://login.bank.example",
      notes: "the joint account",
      otp_seed: "«sealed»",
    };
    // A ROTATION, read off its plain witness: `password_set_at` moves and the
    // ciphertext does not say what it was.
    execute("locker.edit_item", {
      ...bankDraft,
      password: "a-rotated-password-42",
    });
    // A RETAG, which must NOT re-stamp the age. The fixture is what pins that,
    // and the draft round-trips the placeholder so the secret is left alone.
    execute("locker.edit_item", {
      ...bankDraft,
      password: "«sealed»",
      tags: ["money", "joint"],
    });
    // A round-tripped placeholder leaves a card's secrets alone.
    execute("locker.edit_item", {
      item_id: card.item_id,
      cardholder: "A Lovelace",
      card_number: "«sealed»",
      expiry: "2030-01",
      cvv: "«sealed»",
      brand: "visa",
    });
    const copy = execute<{ item_id: string }>("locker.duplicate_item", {
      item_id: bank.item_id,
    });
    execute("locker.clear_passkey", { item_id: copy.item_id }, "any");
    // THE TWO DERIVATIONS, which v0 computes inside the sealed boundary. Their
    // OUTPUT SHAPES CHANGE in the port (D-1020-L6) and the fixture records
    // v0's, which is what makes the change visible rather than silent.
    execute("locker.watchtower", {});
    execute("locker.totp_code", { item_id: bank.item_id });
    execute("locker.totp_code", { item_id: card.item_id }, "any");
    execute("locker.counts", {});
    // THE MASS UNSEAL. Confirmed, receipted, and its answer is every secret —
    // which is why the case is recorded with its output canonicalised and the
    // plaintext never written down.
    execute("locker.export", { confirm: true });
    execute("locker.export", { confirm: true, include_history: true });
    // A purge, last, so every other case reads a vault that still has the row.
    execute("locker.purge_item", { item_id: wifi.item_id });
    execute("locker.purge_item", { item_id: wifi.item_id }, "any");

    // ---- THE QUERIES ------------------------------------------------------
    const ctx = {
      vault: {
        page: (request: {
          query: Parameters<typeof gateway.page>[1];
          limit: number;
          after?: { sortKey: string; pk: string };
        }) =>
          Promise.resolve(
            gateway.page(owner, request.query, {
              limit: request.limit,
              ...(request.after ? { after: request.after } : {}),
            })
          ),
        invoke: (request: {
          command: string;
          input?: Record<string, unknown>;
        }) =>
          Promise.resolve(
            gateway.invoke(owner, {
              command: request.command,
              input: request.input ?? {},
            })
          ),
      },
    };
    const handlers = await loadHandlers();
    const run = async (
      query: string,
      input: Record<string, unknown>,
      why: string
    ): Promise<QueryCase> => ({
      query,
      input,
      why,
      output: await handlers[query]!({ ctx, input }),
    });

    // THE ACCESS HISTORY HAS NO WRITER LEFT IN v0, so its three receipts are
    // planted — see `plantLockerAccessReceipts` for the finding and why this
    // is oracle construction rather than a fixture edit.
    plantLockerAccessReceipts(db.audit, bank.item_id, () =>
      clock.advance(1_000)
    );

    const queries: QueryCase[] = [
      await run("items", {}, "the default window: 300, live shelf, decorated"),
      await run("items", { limit: 20 }, "the window's floor clamps up from 5"),
      await run(
        "items",
        { archived: true },
        "the archived shelf is asked for explicitly, not filtered client-side"
      ),
      await run(
        "item",
        { item_id: bank.item_id },
        "the detail pane: sealed cells at rest, sidecars, history, attachments"
      ),
      await run(
        "item",
        { item_id: passport.item_id },
        "a template-backed type, whose fields are minted rows"
      ),
      await run(
        "item",
        { item_id: "not-an-item" },
        "a wrong id is item: null, never an error"
      ),
      await run("search", { term: "bank" }, "a title match"),
      await run(
        "search",
        { term: "ada@" },
        "a USERNAME match, over a column the payload never returns"
      ),
      await run(
        "search",
        { term: "" },
        "an empty term is no search, not every row"
      ),
      await run(
        "search",
        { term: "combination" },
        "a note's body is NOT matched — notes are deliberately unsearchable"
      ),
      await run(
        "trash",
        {},
        "the trash shelf, with purge dates and its star kept"
      ),
      await run(
        "watchtower",
        {},
        "the review shelf: weak, reused, last4, over archived items too"
      ),
      await run(
        "access",
        {},
        "the audit window's default 200, both object types"
      ),
      await run(
        "access",
        { item_id: bank.item_id },
        "the window pinned to one item"
      ),
      await run("access", { limit: 20 }, "the window's floor"),
      await run(
        "autofill-candidates",
        {},
        "secret-free live login metadata: OTP presence is a boolean"
      ),
      await run(
        "autofill-item",
        { item_id: bank.item_id, page_origin: "https://www.bank.example" },
        "a registrable-domain match"
      ),
      await run(
        "autofill-item",
        { item_id: pinned.item_id, page_origin: "https://www.example.com" },
        "an exact-host login refuses a sibling host — the policy working"
      ),
      await run(
        "autofill-item",
        {
          item_id: bank.item_id,
          page_origin: "https://bank.example.attacker.test",
        },
        "suffix confusion refused"
      ),
      await run(
        "autofill-item",
        { item_id: note.item_id, page_origin: "https://www.bank.example" },
        "a non-login is not a fill candidate at all"
      ),
      await run(
        "autofill-item",
        {
          item_id: bank.item_id,
          page_origin: "https://www.bank.example/login",
        },
        "a URL is not an origin"
      ),
      await run(
        "autofill-item",
        { item_id: "not-an-item", page_origin: "https://www.bank.example" },
        "a wrong id names no login"
      ),
    ];

    const rows = LOCKER_PARITY_TABLES.map((table) => {
      const columns = (
        db.vault.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      const fetched = db.vault
        .prepare(
          `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${columns[0]}`
        )
        .all() as Record<string, string | number | null>[];
      return {
        table,
        columns,
        rows: fetched.map((row) =>
          columns.map((column) =>
            canonicaliseCell(table, column, row[column], row)
          )
        ),
      };
    });

    return canonicaliseBundle(
      { rows, queries, commands, scenarios: null },
      canonicaliser()
    );
  } finally {
    clock.restore();
    db.close();
  }
}
