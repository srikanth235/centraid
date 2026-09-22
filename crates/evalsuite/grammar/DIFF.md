# The derived grammar, diffed against the written one

GENERATED — `python3 derive/derive_grammar.py && python3 derive/diff.py`.

`derive/derived.json` is the terminal set the ontology supports, walked out of the DDL, the registries, the eight app manifests, the search domains and the typed command registry. This diffs it against `check.py`'s lexicons — the grammar AS EXECUTED, since `check.py` generated every tree in `map.json`.

**A: 9 · B: 14 · C: 5**

|                                                 |                  |
| ----------------------------------------------- | ---------------- |
| entities in the registry                        | 96               |
| (entity, door) kinds the doors serve            | 119              |
| Kinds the grammar names                         | 24 + `things`    |
| registered commands                             | 148              |
| Verb terminals the grammar admits               | 148              |
| link walks derived                              | 2081             |
| commands whose effect the ontology states       | 148 / 148 (100%) |
| of those, DECLARED rather than read off the SQL | 26               |
| commands whose effect leaves the vault          | 2                |
| reader-computed Fields declared                 | 5                |

---

## R. Roles — what each entity IS

Every one of the 96 registry entities declares a `role`. The shape of a table used to be the classifier — a `(X_type, X_id)` pair meant edge, an owned child with a label meant facet — and a classifier that reads column names cannot tell `social.contact_channel`, which People serves as a board, from `locker.item_field`, which is only ever reached through its item. The declaration is now the classifier and the shape is the CHECK: a declared edge whose table relates nothing fails the derivation, and so does a `thing` whose table anchors a polymorphic pair to `core_entity`.

| role         | entities | surface                           |
| ------------ | -------- | --------------------------------- |
| `thing`      | 72       | the kind/internal rule, unchanged |
| `edge`       | 15       | `internal`                        |
| `revision`   | 1        | `internal`                        |
| `vocabulary` | 2        | `internal`                        |
| `facet`      | 6        | `facet`                           |

### R1. Unanchored polymorphic pairs (6)

A `(X_type, X_id)` pair the DDL does NOT hold to `core_entity` with a composite foreign key: nothing constrains the id to a row that exists, or ever existed. 15 other pairs ARE anchored, so this is a difference the schema makes deliberately somewhere and by omission elsewhere — and the derivation cannot tell which. **The DDL is not changed here.** `core_entity`'s own pair is a seventh and is excluded from the table: it is the anchor, and has nothing above it to point at.

| table | entity | role | pair | reading |
| --- | --- | --- | --- | --- |
| `access_provenance` | — outside the 96 — | — | `(entity_type, entity_id)` | deliberate — provenance says where a row CAME FROM, and a purge that erased the record of the import would erase the only answer to `why is this here`. It is also outside the 96, so no role carries it. |
| `access_receipt` | — outside the 96 — | — | `(object_type, object_id)` | deliberate — the receipt plane is append-only and hash-chained by `seq`. A receipt that vanished with its object is not a receipt (D-1020-L3 says so for the Locker reveal in as many words). |
| `access_seed_row` | `access.seed_row` | `edge` | `(target_type, target_id)` | gap — a seed row names a planted row and nothing keeps the two in step, so a purged fixture leaves a seed row pointing at an id that was never reissued. Low stakes, machinery only; an anchor with `ON DELETE CASCADE` is what the other thirteen edges have. |
| `agent_evidence` | — outside the 96 — | — | `(entity_type, entity_id)` | deliberate — evidence is what an agent CITED at the time, and it has to read back after the cited row is gone or the audit answers nothing. |
| `core_entity_revision` | `core.entity_revision` | `revision` | `(entity_type, entity_id)` | split — deliberate against TRASH (an undo must read the prior state of a row that is in the bin), a gap against PURGE: nothing prunes a revision when its entity is purged, so `tally.undo_expense` can be offered a revision of a row that no longer exists in any sense. The owner's call is whether purge should cascade here. |
| `share_authority` | `share.authority` | `edge` | `(subject_type, subject_id)` | gap, and the sharpest of the seven — an authority is a live capability, and `(subject_type, subject_id)` unanchored means a grant can outlive its subject and be served against an id the vault has since reissued to something else. |

---

## S. Surfaces — what a member can name (2026-09-22)

The doors serve 119 (entity, door) pairs and a member never sees most of them. Every read scope in `crates/apps/*/manifest.json` now declares a `surface`; `derive_grammar.py` computes the DEFAULT from the ontology and `emit.py` refuses a grammar Kind whose scope is not declared `kind`, and a scope declared `kind` the grammar names no word for.

| surface    | pairs |
| ---------- | ----- |
| `kind`     | 24    |
| `facet`    | 7     |
| `internal` | 88    |

**The `kind` pairs** — one per Kind in GRAMMAR.md §2.1: `core.account@tally`, `core.activity@people`, `core.collection@notes`, `core.collection@photos`, `core.content_item@photos`, `core.document@docs`, `core.event@agenda`, `core.party@people`, `core.party@tally`, `core.place@photos`, `core.transaction@tally`, `knowledge.note@notes`, `knowledge.note@people`, `locker.item@locker`, `people.important_date@people`, `people.profile@people`, `schedule.project@tasks`, `schedule.task@tasks`, `social.circle@tally`, `social.contact_channel@people`, `tally.expense@tally`, `tally.group@tally`, `tally.obligation@people`, `tally.settlement@tally`

**The `facet` pairs** — reachable only as `X of (Kind …)`: `core.party_identifier@people`, `locker.item_field@locker`, `schedule.calendar@agenda`, `schedule.section@agenda`, `schedule.section@tasks`, `tally.expense_line_item@tally`, `tally.recurring_expense@tally`

### S1. Overrides (7)

A manifest may override the rule's default and must then say why.

| pair | default | declared | why |
| --- | --- | --- | --- |
| `core.account@tally` | `internal` | `kind` | Tally imports statement lines, so a member names their accounts to file them (#916 wave ruling). |
| `core.place@photos` | `internal` | `kind` | Photos serves places as their own board — GRAMMAR.md §2.1 Kind `places` — although no command creates one; places arrive with imported assets. |
| `schedule.project@agenda` | `kind` | `internal` | Projects are Tasks' board; Agenda joins through the project only to colour an event. |
| `schedule.task@agenda` | `kind` | `internal` | Tasks' own door serves the board; Agenda reads tasks to place them on the day. |
| `schedule.task@notes` | `kind` | `internal` | Notes reads tasks only to follow a checklist line it sent to Tasks. |
| `tally.friend@tally` | `kind` | `internal` | A friend row is the edge that admits a party to Tally; the board a member names is `members`. |
| `tally.nudge@tally` | `kind` | `internal` | A nudge is a prepared reminder, read back through the obligation it belongs to, never asked for as a board. |

### S2. Kinds added by the declaration

Five Kinds land in GRAMMAR.md §2.1 because a door declares their scope `kind`: `notebooks` (`core.collection` at the notes door, the door's own word — `create-notebook`, `library.notebooks`), `circles` (`social.circle` at tally), `projects` (`schedule.project` at tasks), `accounts` (`core.account` at tally) and `transactions` (`core.transaction` at tally). Each is served by the executor through that door's own read: the Tasks board's `projects`, the Notes library's `notebooks`, Tally's `GroupRow.circle_id` and its own `tally.matches.transactions` / `tally.matches.accounts` statements.

**No corpus turn exercises any of the five.** They are grammar REACH, not evaluation cases: nothing was added to `suite.json`, `blind.json`, `holdout.json` or the training corpus for them, so a candidate is neither rewarded nor penalised for naming one today.

---

## E. Egress — what leaves the vault

`CommandDefinition` had `sealed_input`, `online_only`, `risk` and `confirm` and nothing that said an effect leaves the vault, so `exec.rs` carried a hand-written list of one name and missed `locker.export` — R-R2's own worked example. The registry now declares it (`DECLARED_EGRESS`), `derive_grammar.py` fails on a structural candidate nobody has ruled on, and `emit.py` generates the set into both parsers. `none` is a ruling and is written down like any other.

**The refusal set** — `canon::egress_verbs()`: `locker.export`, `social.send_message`

| command | egress | why |
| --- | --- | --- |
| `locker.add_item` | `none` | `online_only` and sealed-input: the seat seals the secret before the gateway sees it. Nothing leaves. |
| `locker.duplicate_item` | `none` | copies one item's sealed cells to a second row inside the same vault; the ciphertext never leaves. |
| `locker.edit_item` | `none` | as `locker.add_item` — the seat seals, the vault stores. |
| `locker.export` | `export` | every secret the locker holds, in the clear, in a file the seat writes. |
| `locker.reveal_receipt` | `none` | records that a seat revealed something. The reveal left custody; writing down that it did, did not. |
| `locker.rotate_key` | `none` | `online_only` because the seat holds the key it rotates; the new key never leaves that seat. |
| `locker.set_field` | `none` | as `locker.add_item` — the seat seals, the vault stores. |
| `locker.set_passkey` | `none` | as `locker.add_item` — the seat seals the private key, the vault stores it. |
| `locker.totp_code` | `none` | derives a code at the member's own seat; it is shown, not sent. |
| `locker.watchtower` | `none` | reads the locker's own rows and answers at the seat. |
| `social.draft_message` | `none` | a draft is a row and stays one; sending it is `social.send_message`. |
| `social.send_message` | `transport` | the member's request is for the message to ARRIVE; the row it records is the vault's half of a transfer. |
| `tally.materialize_recurring_expense` | `none` | `online_only` so the recurrence plane is reachable, not because anything is handed out. |
| `tally.nudge` | `none` | writes one row saying a reminder was PREPARED, with `sent` stated and always false, because no delivery path exists. |

---

## D. Reader-computed Fields, declared

GRAMMAR.md §2.2 admits Fields an app's reader computes and hands back beside the row; they are in no column list, so the only statement that one existed was the grammar naming it. Each owning app now declares what computes the field and which tables that reader reads, and manifest validation refuses an input the app's own read scopes do not grant. `computedBy: —` is the product signal made explicit: the grammar states the Field, the corpus scores it, and nothing shipped produces it.

| field | app | entity | computedBy | inputs |
| --- | --- | --- | --- | --- |
| `balance` | `tally` | `core.party` | `crates/apps/tally/src/balance.rs` | `tally.expense`, `tally.expense_payer`, `tally.expense_split`, `tally.settlement`, `tally.group` |
| `member_party_ids` | `tally` | `tally.group` | **—** | `tally.group`, `social.circle`, `social.circle_member` |
| `next_occurrence` | `people` | `people.important_date` | **—** | `people.important_date` |
| `owed_to_me` | `people` | `core.party` | **—** | `tally.obligation`, `core.party` |
| `owed_to_them` | `people` | `core.party` | **—** | `tally.obligation`, `core.party` |

---

## A. The ontology supports it, the grammar lacks it

### A1. 8 boards the doors serve and the grammar names no Kind for

Each is life data (a non-machinery registry entity that is not a projection), has a single-column primary key, carries a human label column, and sits inside at least one door's declared READ scope. A member can see these rows in the app and cannot ask about them in canonical English. `core.vault` is the owner's own singleton and is the one row here that is arguably plumbing.

| entity | table | label column | doors that read it | lifecycle |
| --- | --- | --- | --- | --- |
| `core.collection` | `core_collection` | `name` | notes, photos | mutable |
| `core.party_identifier` | `core_party_identifier` | `value, label` | people | mutable |
| `core.vault` | `core_vault` | `display_name` | agenda, people, tally | mutable |
| `locker.item_field` | `locker_item_field` | `label` | locker | mutable |
| `media.asset` | `media_asset` | `title` | notes, photos | trash |
| `schedule.section` | `schedule_section` | `name` | agenda, tasks | mutable |
| `tally.expense_line_item` | `tally_expense_line_item` | `description` | tally | mutable |
| `tally.recurring_expense` | `tally_recurring_expense` | `description` | tally | mutable |

**Turns affected:** none

### A2. 5 columns on kinds the grammar already names

columns of the base tables behind the grammar's own Kinds that no canonical can name: `card_number`, `content`, `cvv`, `otp_seed`, `password`

**Turns affected:** none

### A3. the CHECK value sets as an `in (…)` domain

24 enum columns on the grammar's own Kinds carry a `CHECK (col IN (…))`, so `in (…)` has an exactly-enumerable domain per column. `check.py` validates no literal against it — any string parses — so a canonical may name a value the column forbids and nothing says so. The check is free and is implemented in this diff.

**Turns affected:** none

### A4. `delete` over `media.asset`

the registry holds `media.delete_asset`; the class does not list this subject.

**Turns affected:** none

### A5. `reschedule` over `schedule.calendar`

the registry holds `schedule.propose_event`; the class does not list this subject.

**Turns affected:** none

### A6. `restore` over `media.asset`

the registry holds `media.restore_asset`; the class does not list this subject.

**Turns affected:** none

### A7. 42 link walks between the grammar's own Kinds that no canonical uses

the DDL relates these base tables, so §2.3 already makes each one legal; none is exercised, which is corpus coverage rather than a grammar gap. Sample: `core.party of (core.account)`, `core.transaction of (core.account)`, `core.party of (core.activity)`, `core.place of (core.activity)`, `core.document of (core.content_item)`, `core.party of (core.content_item)`, `knowledge.note of (core.content_item)`, `core.content_item of (core.document)`, `core.place of (core.event)`, `core.account of (core.party)`, `core.content_item of (core.party)`, `core.transaction of (core.party)` …

**Turns affected:** none

### A8. `called` over the kinds with no FTS domain

GRAMMAR.md §4 says `called` falls back to a board scan where the Kind has no domain. The kinds that take that path: `core.account`, `core.activity`, `core.place`, `core.transaction`, `knowledge.notebook`, `locker.item`, `media.album`, `people.important_date`, `people.profile`, `schedule.project`, `social.circle`, `social.contact_channel`, `tally.group`, `tally.obligation`, `tally.settlement`. The ontology supports it (each has a label column); it is worth stating that the FALLBACK, not the plane, is what answers there.

**Turns affected:** none

### A9. 14 party-subject verbs the schema derives and `exec.rs` does not list

A command whose input schema's ONLY foreign-key argument is a party has exactly one party subject — that is the schema saying R-C1 applies. The derivation finds `core.update_party`, `media.forget_person`, `people.add_debt`, `people.add_gift`, `people.add_important_date`, `people.add_note`, `people.add_task`, `people.edit_person`, `people.restore_person`, `people.set_cadence`, `people.star_person`, `people.unstar_person`, `social.resolve_identity`, `tally.add_friend`. Each would clarify over several rows called the same name, and today does not.

**Turns affected:** none

---

## B. The grammar claims it, the ontology or the doors cannot serve it

### B1. Kind `albums` → (media.album, photos)

`media.album` is not a logical entity in `contracts/schema/v0-registries.json` at all.

**Turns affected:** `b38.0`, `b42.0`, `h35.1`, `h64.1`, `h68.0`, `s109.1`, `s109.2`, `s109.5` … (+6)

### B2. Kind `notebooks` → (knowledge.notebook, notes)

`knowledge.notebook` is not a logical entity in `contracts/schema/v0-registries.json` at all.

**Turns affected:** none

### B3. 8 reader-computed Fields — CLOSED, now checked

GRAMMAR.md §2.2 admits Fields an app's reader computes and named no file for any of them, so there was nothing to check the list against and nothing that went red when a reader dropped one. Each of these now declares its source in `derive/terminals.json` and `emit.py` refuses one no file under `crates/apps/*/src` and no app manifest mentions: `album`, `album_titles`, `attendee_party_ids`, `favorite`, `folder`, `notebooks`, `place`, `starred`. Listed so the closure is visible; the four below are the ones still open.

**Turns affected:** `b34.0`, `b36.0`, `b39.0`, `h14.0`, `h15.0`, `h16.0`, `h17.0`, `h29.0` … (+18)

### B4. Field `member_party_ids` is computed by nothing the product ships

no column of that name in `contracts/schema/vault-ddl.sql`. `tally` now DECLARES it under `derivedFields` with `computedBy: null` and the note: A group's members are reached through `social.circle_member`, and no shipped query hands the id list back beside the group row; the grammar's Field is served only by the eval harness (DIFF.md B4). It is also the two-hop walk DIFF.md B12 records. It exists in `crates/candidates/src/exec.rs` and in the eval harness's reference readers and nowhere else, so the grammar states a Field whose only implementation is the thing being evaluated. The gap is unchanged; what changed is that the product now says so where a reader would look.

**Turns affected:** none

### B5. Field `next_occurrence` is computed by nothing the product ships

no column of that name in `contracts/schema/vault-ddl.sql`. `people` now DECLARES it under `derivedFields` with `computedBy: null` and the note: The next anniversary of a `month_day`. The dates board sorts by the stored columns and never projects the next occurrence; no shipped reader computes it (DIFF.md B5). It exists in `crates/candidates/src/exec.rs` and in the eval harness's reference readers and nowhere else, so the grammar states a Field whose only implementation is the thing being evaluated. The gap is unchanged; what changed is that the product now says so where a reader would look.

**Turns affected:** `b16.0`, `h21.0`, `s84.0`, `s85.0`

### B6. Field `owed_to_me` is computed by nothing the product ships

no column of that name in `contracts/schema/vault-ddl.sql`. `people` now DECLARES it under `derivedFields` with `computedBy: null` and the note: People ships no obligation reader. `tally.obligation` is in this app's read scopes and no query returns a per-party total; the field's only implementation is the eval harness's reference reader, which is the thing being evaluated (DIFF.md B6). It exists in `crates/candidates/src/exec.rs` and in the eval harness's reference readers and nowhere else, so the grammar states a Field whose only implementation is the thing being evaluated. The gap is unchanged; what changed is that the product now says so where a reader would look.

**Turns affected:** `s106.0`

### B7. Field `owed_to_them` is computed by nothing the product ships

no column of that name in `contracts/schema/vault-ddl.sql`. `people` now DECLARES it under `derivedFields` with `computedBy: null` and the note: As `owed_to_me`, the other direction. No shipped reader (DIFF.md B7). It exists in `crates/candidates/src/exec.rs` and in the eval harness's reference readers and nowhere else, so the grammar states a Field whose only implementation is the thing being evaluated. The gap is unchanged; what changed is that the product now says so where a reader would look.

**Turns affected:** `s53.0`

### B8. walk `core.place of (core.content_item …)` is 2 hops, not one

§2.3 derives a walk from ONE foreign key read either way. The foreign-key paths between these two base tables, shortest first: `core_content_item` → `media_asset` → `core_place`; `core_content_item` → `access_device` → `media_asset` → `core_place`; `core_content_item` → `core_party` → `core_activity` → `core_place`. Which one the walk MEANS is a judgement nothing in the schema records. The door can serve it; what the grammar's stated derivation rule produces is not this walk. Either §2.3 admits multi-hop walks and says how many, or the intermediate table is itself a Kind and the canonical says both hops.

**Turns affected:** `h41.0`, `h68.2`, `s50.0`, `s50.1`

### B9. walk `media.album of (core.content_item …)` has no foreign key at all

the only thing relating these two base tables is `core_collection_entry (target_type/target_id)` — a `(type, id)` PAIR, not a foreign key. §2.3 says walks come "from the foreign keys, not from a second list" and names `core_collection_entry` as a join table; it is not one. Nothing in the schema constrains `target_id` to a live row of `target_type`, so the walk is servable only because the app's reader knows which type to filter on — which is precisely the second list §2.3 says it does not have.

**Turns affected:** `s109.5`

### B10. walk `core.content_item of (core.place …)` is 2 hops, not one

§2.3 derives a walk from ONE foreign key read either way. The foreign-key paths between these two base tables, shortest first: `core_place` → `media_asset` → `core_content_item`; `core_place` → `core_activity` → `core_party` → `core_content_item`; `core_place` → `core_event` → `core_party` → `core_content_item`. Which one the walk MEANS is a judgement nothing in the schema records. The door can serve it; what the grammar's stated derivation rule produces is not this walk. Either §2.3 admits multi-hop walks and says how many, or the intermediate table is itself a Kind and the canonical says both hops.

**Turns affected:** `b40.0`, `h18.0`, `s120.1`, `s15.0`, `s59.0`, `s97.1`

### B11. walk `core.content_item of (media.album …)` has no foreign key at all

the only thing relating these two base tables is `core_collection_entry (target_type/target_id)` — a `(type, id)` PAIR, not a foreign key. §2.3 says walks come "from the foreign keys, not from a second list" and names `core_collection_entry` as a join table; it is not one. Nothing in the schema constrains `target_id` to a live row of `target_type`, so the walk is servable only because the app's reader knows which type to filter on — which is precisely the second list §2.3 says it does not have.

**Turns affected:** `b38.0`, `s29.0`, `s68.0`

### B12. walk `core.party of (tally.group …)` is 2 hops, not one

§2.3 derives a walk from ONE foreign key read either way. The foreign-key paths between these two base tables, shortest first: `tally_group` → `social_circle` → `core_party`; `tally_group` → `tally_expense` → `core_party`; `tally_group` → `social_circle` → `social_circle_member` → `core_party`. Which one the walk MEANS is a judgement nothing in the schema records — `tally_group` → `social_circle` reaches the circle's OWNER and `→ social_circle_member` reaches its members, and only the second is what a member means by "who's in the group". The door can serve it; what the grammar's stated derivation rule produces is not this walk. Either §2.3 admits multi-hop walks and says how many, or the intermediate table is itself a Kind and the canonical says both hops.

**Turns affected:** `s31.0`, `s74.0`

### B13. `PARTY_SUBJECT` names `people.settle_debt`

its input schema carries more than one foreign-key argument, so its subject is not one party by the schema's own shape.

**Turns affected:** none

### B14. `PARTY_SUBJECT` names `tally.add_group_member`

its input schema carries more than one foreign-key argument, so its subject is not one party by the schema's own shape. `tally.add_group_member` takes a `group_id` AND a `party_id`: the rule that fires on it is real, but the list is the thing carrying it, not the schema.

**Turns affected:** none

---

## C. Naming-only

### C1. `delete` over `core.content_item` → `media.delete_asset`

the command is registered, but its input schema's subject argument names a different entity, so the derivation files it under that one. `media.delete_asset` takes an `asset_id`: its subject is `media.asset`, and `core.content_item` is the entity the asset hangs off.

**Turns affected:** none

### C2. `reschedule` over `schedule.task` → `schedule.edit_task`

the command is registered, but its input schema's subject argument names a different entity, so the derivation files it under that one. The two spellings denote the same effect.

**Turns affected:** none

### C3. `restore` over `core.content_item` → `media.restore_asset`

the command is registered, but its input schema's subject argument names a different entity, so the derivation files it under that one. The two spellings denote the same effect.

**Turns affected:** none

### C4. `media.album` (GRAMMAR.md §2.1) vs `core.collection` (the registry)

the grammar's `albums` Kind is written `media.album`, and no entity of that name exists. The base table GRAMMAR.md itself names — `core_collection` — belongs to `core.collection`, which the photos door does read. Same board, two spellings; the stored trees carry the spelling that is not the ontology's.

**Turns affected:** `b38.0`, `b42.0`, `h35.1`, `h64.1`, `h68.0`, `s109.1`, `s109.2`, `s109.5` … (+6)

### C5. `core.content_item` (GRAMMAR.md `photos`) vs `media.asset`

GRAMMAR.md §2.1 already says the `photos` Kind is `core_content_item`+`media_asset`. Both entities exist and the photos door reads both; the grammar names the first and the delete command takes the second's id.

**Turns affected:** none
