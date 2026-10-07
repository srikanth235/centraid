# Issue #1044 — the native tool task: a 0.8B model drives the vault through eight tools

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it. Decisions: the #1044 section of [docs/decisions.md](../docs/decisions.md). The experiment: [experiments/toolchat/native/README.md](../experiments/toolchat/native/README.md).

## Checklist

- [x] **Wave S — one setup**: frozen v4 sets in `eval/sets` with hashes and a reference check; greedy-only scoring with clean turn pass; the v3 slot trace as the only format; one bundle and GCP path; the wave-era tooling, the legacy generator and the versioned set copies removed; README, decisions and this receipt.
- [x] **Phase 1 — measure composition**: on the recorded val run, how many failing turns each harness feature would flip (replayed where possible), the selector micro-benchmark, the context-length numbers.
- [x] **Phase 2 — the harness composes** (first half; the trace compiler is the second half): validation before execution, the grounding menu, runtime-resolved dates, the conventions as code (D-1044-7 to D-1044-10), the focus line, the trace compiler; each landing green on the crate tests, the reference check and a CPU replay.
- [x] **Phase 3 — data through the new harness**: gold regenerated as a versioned freeze, train records with the new trace, the train-fit sample and the loss slice; hygiene, distribution and reference checks.
- [ ] **Phase 4 — one retrain**: train fit and val scored greedy; test at a milestone the owner names.
- [ ] **Phase 5 — if val is under 85**: collision-rich worlds and error-recovery turns, one more retrain, then test.

## Evidence: where the current model stands (before wave S)

The retrained 0.8B (v3 slot trace, 3,869 train sessions, 6 epochs, about 63 minutes on one Spot H100) on the v4 val set: 396 of 655 sessions (60.5%), 1,651 of 2,055 turns (80.3%). Train fit at the halfway checkpoint: 76.0% of the 300-session sample; val at that checkpoint 51.9%. Voting over six candidates per step: no gain; oracle ceiling about five points. The hand diagnosis of all 259 failing sessions (first failing turn, one root cause each): wrong selector 64, wrong reference 37, wrong value 35, wrong date 28, wrong verb 28, ask-versus-decline 19, gold questionable 13, the rest asks and dead ends. Runtime error texts absent from train appear in 42 failing sessions; turns that hit one fail 91% of the time against 35%. Twenty-six sessions carry a train-versus-eval label conflict (status vocabulary 7, ask options 6, vault refusal 4, past-and-upcoming 3, what-else 2, normalisation 2, biggest 1, date 1).

Measured on the same run: 85% session pass over 3.1 turns per session needs about 95% turn pass; of failing turns, 15% began with an invalid call, 15% with an empty result, 11% ended in a repeated-call loop and 25% took three or more steps, against 2%, 3%, 0% and 3% of passing turns; the longest quarter of turns by context fails at 26% against 16 to 18%.

## Evidence: wave S, the one setup (2026-10-02)

Five slices under one brief, integrated and checked together (`eval/test_score`, `test_replay`, `test_loop`, `train/test_batching`, `test_decision`, `test_resume`, `test_trace3`, `authored/test_trace` green; `build_sets.py check` 1,611 sessions ok; `split.py --check` current; bundle dry build, `bundles.sh` for the three sets and the `score_ckpt.sh` dry run ok). `train/test_precision`'s bit-identity case (`dt_bias`) fails before and after the wave; it is not this wave's.

- **Sets.** `eval/sets/{val,test,trainfit}.jsonl` and `split.json` are the frozen v4 sets (val 655 sessions / 2,055 turns, test 656 / 2,075, seven held-out worlds A B C D T03 T12 T23; trainfit 300 / 940 as a fixed sample of the 25 train worlds); hashes and the reference check (val and test 100% through the runtime) in `eval/FROZEN.md`. `eval/build_sets.py` has `check` (default), `ref`, `trainfit --train-gold GLOB [--keep-ids]` and `pool`. The e1 sources moved to `eval/sessions/e1/` with a README of provenance.
- **Scoring.** Greedy only: the sample bank, voting and the golden-mock path are gone (`eval/{voting,vote,bank,synth_bank,golden_mock,test_vote}.py`, `train/{test_vote_batching,confidence}.py`, `eval/golden/`); the bank cost six times the tokens of a greedy run for about the same session pass. `eval/score.py` reports sessions, clean turns (turns up to a session's first failure, with a Wilson interval) and all turns, in that order; `train/vm/*` summaries carry the same three.
- **Data.** `data/train.jsonl.gz` (3,869 sessions / 12,304 turns) and `data/train-val.jsonl.gz` (421) are the only artefacts; `data/README.md` has the recipe and hashes. The versioned copies `data/final-{v2,v3,v3-eval,v3.1-eval,v4-eval}` and the legacy generator (`data/*.py`, `build.sh`, `run_checks.sh`) are removed; the v3.1 change list that only ever lived uncommitted is preserved below.
- **One trace format.** `authored/build.py` writes the v3 slot trace only (T01 and T15 byte-identical to the last full build); `authored/trace.py` lost its v2 path; `train/*` lost `NATIVE_THINK` and `NATIVE_RENDER_CALL`; `CONTRACT_V2.md`, `authored/{trace_check,contract_check}.py` and `train/_train_old.py` are removed.
- **One training path.** `train/kaggle.py` became `train/bundle.py` (Kaggle push, status and fetch removed; `BUNDLE_STAGE`, `BUNDLE_NATIVETOOLS`; the optimised eval defaults are the defaults); `train/vm/bundles.sh` stages the three sets; `train/vm/{launch,watch,score_ckpt,run_job}.sh` are the GCP Spot path.
- **Tooling removed.** `authored/{audit,gapreport,gapcheck,quota_check,seed_red,select}.py` and their json, `GAPBRIEF.md`, `GBRIEF.md`, `GOALS.md`, `PLAN.md`, `eval/{review,coverage}.py`; `authored/evalkit/{KIT.md,check.sh,hyg.py,mix.py}` is the one authoring kit. `eval/engineered.py` has no caller left and is deleted by hand (the automated deletion was refused).
- **Docs.** `experiments/toolchat/native/README.md` (the one-page map), `SPEC.md` §11 to §13 (data and training, build plan, metric strategy: the headline is test session pass at a milestone, the steering number is clean turn pass on val), `docs/decisions.md` D-1044-1 to D-1044-11.

## Evidence: phase 1, how much of the val gap is composition (2026-10-02)

The recorded greedy run of the current model on val (396/655 sessions, 1,651/2,055 turns, clean turns 1,428/1,687 = 84.7%) replayed through the runtime reproduces exactly. Each candidate harness feature rewrote the recorded model messages and the real driver replayed them; flips are failing-to-passing / passing-to-failing on clean turns.

| feature | addressed | flips, clean |
|---|---|---|
| refer rows substituted under the guard rule | 7 turns | +1 / -0 |
| `status = open` as open + in_progress (against the v4 gold) | 57 turns | +6 / -7, est. +21 turns under regenerated gold |
| ask options = every listed candidate | 42 asks | +2 / -0 |
| search, then `rows=#n`, on an empty name | 56 steps | +3 / -0 |
| deterministic repairs on the first error reply | 92 turns | +13 / -8 (the -7 is the restore-window decline against the v4 gold) |
| all together, without the restore decline | 168 turns | +21 / -7; sessions 396 to 403 (61.5%) |

Of the 2,764 recorded calls, 2,755 equal the call compiled from their own trace: compiling calls from slots gains nothing by itself. The 376 failing turns no feature touches are values the model judged wrongly (status 27 of 34 failing turns disagree with gold, args 49 of 73, when 39 of 61, linked_to 34 of 57, name words 41 of 103); where no gold slot disagrees, 95.5% of turns pass, where one does, 53.3%. Prompt length is a weak lever (odds ratio 1.41 per 336 tokens, mostly downstream turns). Ruling: D-1044-11; the levers for the 376 are new prompt inputs (the grounding menu, the dates line, the focus line), the conventions in the gold and the training data, and a retrain. Scripts and raw outputs: the session scratchpad `phase1/` (not committed).

## Evidence: phase 2, the harness composes (2026-10-02)

Four runtime slices in `crates/nativetools`, each gated the same way (crate tests, the reference check of val and test, a replay of the recorded val run of the current model, the seeded worlds' keys unchanged), then integrated: 343 crate tests, clippy `-D warnings` and rustfmt clean on the integrated tree.

- **R1, matching and the grounding menu** (`search.rs`, `ground.rs`, `meta.rs`, `render.rs`): names match with accents and case folded and a person's nickname as a name of theirs; a name that matches nothing is read once more as words and word starts and the one fit is taken, with a `matched` line in the reply (several fits: `ambiguous:`, none: the dead end as before); the vault block lists up to 8 rows, exact names first, no kind past half the slots while another has a hit, containers with their live child count. No val or test gold changes. Replay, renumbered: +2 turns, -0. Block recall of the rows the train references pick: 80.4% to 93.8%.
- **R2a, the status convention** (`whr.rs`): `status = open` selects open and in_progress on tasks, `!= open` the rest, `in (…)` member by member (D-1044-7). 19 reference turns change gold (16 fail the v4 gold); train: about 4% of sessions need their gold regenerated.
- **R3, the session loop** (`session.rs`, `prompt.rs`, `phrases.rs`, `dates.rs`): the user turn's block gains a `focus:` line (rows created this session, the last result's rows, the options of the ask just made) and a `dates:` line (each date or time phrase with its resolution by the runtime's own evaluator; two honest readings print both); an ask right after an `ambiguous:` reply is completed to every candidate (D-1044-9); a repeated invalid call ends the turn on its first repeat. Replay: +3 turns, -0. 16 reference turns change effect (ask option lists), none fails. On train, 3,001 of 12,304 turns get a dates line and it names 83.7% of the gold's date leaves.
- **R2b, the write path** (`act.rs`, `session.rs`, `vaultio.rs`): a write over `ROW_CAP` (12) rows is never run outright and ends in the runtime's ask with the count; the same write after a plain yes in the next turn goes through once; a restore past the window ends in `decline not_found` and a delete of a non-empty folder, group or notebook in an ask; the `ambiguous:` list puts rows that are not over first, nearest first (D-1044-10, D-1044-12). 18 reference turns change gold (14 restores, 3 refused deletes, 1 write over the cap). Replay, renumbered, R2b's share: +6 / -8, the 8 all deliberate gold changes. The 734-row deletion of val session D-E053 no longer happens.
- **Integrated reference check** (binary `nt-stage1`, before the v5 refreeze): val 637/655 sessions, 2,032/2,055 turns; test 645/656, 2,064/2,075. Every failing turn is one of the 34 deliberate gold changes (16 status, 18 refusal or cap). Renumbered replay of the recorded run: sessions 396 to 395, turns 1,651 to 1,654, clean turns 1,428/1,687 to 1,443/1,703: the recorded model never saw the new lines, so this measures runtime effects alone; the retrain is what the new inputs are for.
- **Four train references repaired at the source** (T07-093, T14-047, T21-080, T24-087): their first call was a deliberate dead end on a nickname or an accented name that the fold now resolves, which would have ended the turn early; the reference is now the one-step call.
- **Measured and withdrawn**: composing the other vault refusals (moved three val sessions the wrong way); a sample bank over the recorded run (voting, D-1044-3).

## Evidence: phase 3, gold and train through the new runtime (2026-10-02)

Two tools, both in the repo: `eval/build_sets.py refreeze` (the reference run of the current runtime replaces the gold of every turn it fails, or passes under a superseded reading, with a single derived accept, and names the convention behind each change: status D-1044-7, what-else D-1044-8, ask-options D-1044-9, refusal D-1044-10, bulk-cap D-1044-12; a change no convention explains, or one that a name-match causes, stops the run) and `authored/build.py --gold-from-ref` (the same derivation and classifier over the train references; a session with an unexplained change is dropped). The derivation is re-scored with the scorer before use; `eval/test_regen.py` holds 95 tests, with 30 mutations of the module all caught. Shared module `eval/regen.py`.

- **Sets v5** (`eval/FROZEN.md`): val 655 sessions / 2,055 turns, 36 turns changed in 30 sessions (status 16, ask-options 10, refusal 10); test 656 / 2,075, 17 turns in 17 sessions (refusal 7, ask-options 6, status 3, bulk-cap 1). 13 gold repairs from the diagnosis applied by id (three ruled as accept-either: T23-046 t1, test-D-097 t1, T12-129 t3; B-E042 t3 and test-D-094 left as they were). 0 unexplained, 0 name-match. Reference check on v5 with the integrated binary: val 655/655 and 2,055/2,055, test 656/656 and 2,075/2,075.
- **Train** (`data/train.jsonl.gz`): 25 worlds built in parallel through the integrated runtime in 366 s; 3,868 of 3,869 sessions kept (T11-039 dropped: a two-row restore whose first row is past the window now declines at the first row and the session's third turn depends on the restore); 12,301 turns; 280 turns regenerated (status 148, refusal 80, ask-options 52). Five train references repaired at the source by one token each (a `bad(act restore name=…)` whose name nobody typed, which the slot trace refuses as unsourced once the composed decline makes the call trained): T10-071, T09-134, T11-129, T20-C902, T26-019.
- **Loss slice** (`data/train-val.jsonl.gz`): 420 records / 1,375 turns (T23-124 lost to the same unsourced-name class, in a val source that is provenance only). **Train fit** (`eval/sets/trainfit.jsonl`): the same 300 ids, 940 turns, 28 rows refreshed.
- **Gates**: `build_sets.py check` ok (1,611 sessions); `gate.py` and `dist.py` fail on the pre-existing conditions recorded under "Open after phase 2" (22 near-duplicate messages, none exact; train against val over threshold on 6 of 8 shape features, session length the worst).
- **Staged**: scoring bundles for trainfit, val and test and the stage-1 job (`bs 16, lr 2e-5, max-len 8192, embed freeze, val-n 400, decision-weight 3.0`; 6 epochs, a checkpoint every 30 steps, set at launch), runtime binary sha256 fbf2cd04… inside every bundle.

## Open after phase 2 (carried into the second half)

- **Bare container readouts.** D-1044-7 reads "what's on the kids list" as the active rows, but the runtime returns every task of a container when the call carries no status condition (R2a was briefed to leave readouts alone) and the train references write no status for that phrasing in about 19 of 22 cases; val and test gold (test-D-094 among them) expect the active rows. The conflict predates this wave and caps val until one of two fixes lands: the runtime hides completed and cancelled rows of a bare readout and says so, or the train references carry `status = open` for the phrasing. Decide and regenerate in the second half.
- **Hygiene and distribution gates.** `authored/gate.py` reports 22 train messages that are near-duplicates (cosine at least 0.95) of val or test messages, none exact; `authored/dist.py` reports train against val over threshold on 6 of 8 shape features (session length the worst) and train against test likewise, val against test fine. Both are properties of the sources and existed at the v4 freeze; recorded, not blocking the retrain.
- **Dialogue after a composed decline.** 50 of the 77 train turns regenerated as `decline not_found` (a restore past the window) are followed by a message that answered the ask the author used to write there ("yeah go on", "no leave it"). The follow-up turns still verify against the runtime; the wording is off. Rewrite or truncate in the second half.
- **Trace on a fallback `answer`.** When the unique-name fallback resolves an `answer`, the turn ends on that row; a wrong fit is a wrong terminal answer (R1's open point). Two fallback uses in 2,055 replayed turns, both benign; revisit with the trace compiler.
- **Identical rows in the block.** 22.5% of train blocks hold two or more rows of one kind and name (recurring events); collapsing them changes what a `#n` means. Not done.

## Evidence: the v3.1 gold corrections (preserved from the uncommitted `data/final-v3.1-eval/CHANGES.md`)

The v3.1 change list was written in the working tree and never committed; the directory is deleted by wave S, so the list is kept here verbatim. The v3 list is at commit e464acab (`data/final-v3-eval/CHANGES.md`).

### final-v3.1-eval: v3 gold corrected to the four convention rulings

Versioned copies of `data/final-v3-eval/{val,test}.jsonl` (v3 and `eval/sets` untouched), built from v3 against the final runtime binary (round 2: R1 revised to aggregates only, R4 extended to every verb's own already-so test, pick ambiguity 3.3c narrowed). Built by `build_v31.py`; effects for every new gold are derived by running the reference calls through the runtime, not hand-written. `{val,test}.jsonl` is what `eval/score.py --gold` and `eval/run.py --set` read; `.jsonl.gz` is the same bytes gzipped. `variants-*.jsonl` is validation only (the v3 alternative refs swapped in). Bundles: `make_bundles.py <src> <dst>`.

sha256: val.jsonl `68aeb9273a18d067a5fbd6b8d9f9ab10902818321185f74657c0d2dbd45a63e7`, test.jsonl `ee9f955275297459beb77a337afbd9149c8278385a255ee7160babb22aa0c641`.

Verified against nt-w1d (reschedule excluded from the already-so test): the reference model scores 100% sessions and turns on v3.1 val (391/391, 1301/1301) and test (450/450, 1309/1309) and on both variants files; no gold changed. v3 on the original binary is still 100%.

#### Method

The reference model (`eval/run.py --model ref`) was run over v3 val and test with the final binary and scored with `eval/score.py --gold`. On the original binary v3 scores 100% on both (391/391 and 450/450 sessions), so every failing turn is a place where the runtime disagrees with the gold. Failing turns: val 14 turns in 9 sessions, test 2 turns in 2 sessions (`FAILING` in `build_v31.py`, asserted). Nothing else was edited: R2 (end of month) and R3 (bare ordinal / month-day in a write) contradict no v3 turn. val T03-021#3 ('what else runs thirty min or less since monday', a row listing) passes unedited under the revised R1.

#### Counts of edited turns

| ruling | val | test |
| --- | --- | --- |
| R1 since closes at today (aggregates) | 1 | 0 |
| R4 applicability | 7 | 0 |
| R4c pick ambiguity (SPEC 3.3c) | 1 | 1 |
| F fail-soft ref ending | 0 | 1 |
| R2 end of month | 0 | 0 |
| R3 ordinal / month-day | 0 | 0 |
| total edited turns | 9 | 2 |
| (turns removed, R4 pick turns made moot) | 7 | 0 |

Replaced vs accepted-alternative: R1 (1) and R4 (7) replace the v3 gold (the ruling says the old outcome is wrong); R4c (2) put the runtime's ask first and keep the v3 write as an accepted alternative; F (1) edits the ref only. Against the first pass of v3.1 (older binary): 7 edits reverted (val T03-021#3, T12-062#1, T23-077#5; test dev-A-109#3, dev-D-004#3, test-D-014#2, test-D-014#5: the ref passes on v3 without them; no accepted ask is kept to tolerate runtime over-reach); 2 edits are new (val T12-048#3, T12-130#2, from the extended R4).

Notes. (R4) a verb's candidates are the rows it would change: 'star the lease doc' with one starred lease, 'add sato to the group' with one Sato already a member, 'pin the hana note' with one note already pinned: the runtime acts on the other one. The v3 turn that only answered the ask ("the renewal", "server key", "the friday one", "the plumber", "the allergies one") or withdrew it ("forget it", "don't bother") has nothing left to answer, so it is removed; the sessions keep their ids and their remaining turns pass. (R4c, kept) val T12-076#5 'and move the video call with takeshi to 9': five events carry that name, the call is a by-name act (no where/when/linked_to), the row was listed two turns earlier (not the previous turn) and the turn before acted on another row, so nothing settles which: the ask is defensible; the v3 write cannot be reached through any call, it stays accepted. test-D-065#1 'the recital is 90 minutes': about 17 'Piano recital' events and the ballet recital all fit the word, the call states nothing that singles the row out and no earlier turn named it: the ask is defensible; the v3 write stays accepted. The asks' candidates are every option the runtime offers when it offers at most six, otherwise the rows the person meant. (F) not a ruling: the v3 ref of test-C-006#3 passed on the step cap; the runtime now ends the cap as an ask. The ref closes with the balance answer, which gold already accepts (value 0 EUR). Follow-ups of an accepted-ask turn are not conditioned on the reading (as in v3).

#### Every edited turn

- **val T03-023#3** [R1 since closes at today (aggregates)]  
  reason: ref unchanged (open span); the runtime closes 'since' at today for an aggregate (SPEC 14.1): the effect is derived from running the ref  
  old: `{"type": "value", "groups": {"tentative": [{"amount": 9, "unit": null}], "cancelled": [{"amount": 1, "unit": null}]}}`  
  new: `{"type": "value", "groups": {"cancelled": [{"amount": 1, "unit": null}], "tentative": [{"amount": 3, "unit": null}]}}`
- **val T12-048#3** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["aiko", "kenta_s"]} | ref [{"tool": "act", "args": {"verb": "add_to", "kind": "person", "name": "Sato", "args": "to: $yearend"}}, {"tool": "ask", "args": {"question": "aiko sato or kenta sato the plumber?", "options": "$aiko, $kenta_s"}}]`  
  new: `{"type": "diff", "diff": {"rows": [], "links": [{"change": "added", "from": "yearend", "to": "kenta_s"}]}} | ref [{"tool": "act", "args": {"verb": "add_to", "kind": "person", "name": "Sato", "args": "to: $yearend"}}]`
- **val T12-105#1** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["lease_2024", "lease_draft"]} | ref [{"tool": "act", "args": {"verb": "star", "kind": "document", "name": "lease"}}, {"tool": "ask", "args": {"question": "the 2024 lease or the renewal draft?", "options": "$lease_2024, $lease_draft"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "lease_draft", "change": "updated", "fields": {"starred": true}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "star", "kind": "document", "name": "lease"}}]`
- **val T12-109#1** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["hygiene", "stall_permit"]} | ref [{"tool": "act", "args": {"verb": "unstar", "kind": "document", "name": "permit"}}, {"tool": "ask", "args": {"question": "the food hygiene permit or the fest stall permit?", "options": "$hygiene, $stall_permit"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "hygiene", "change": "updated", "fields": {"starred": false}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "unstar", "kind": "document", "name": "permit"}}]`
- **val T12-110#1** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["pos", "pos_key"]} | ref [{"tool": "act", "args": {"verb": "star", "kind": "locker item", "name": "POS"}}, {"tool": "ask", "args": {"question": "the shop pos login or the pos server key?", "options": "$pos, $pos_key"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "pos_key", "change": "updated", "fields": {"starred": true}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "star", "kind": "locker item", "name": "POS"}}]`
- **val T12-130#2** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["hana_words", "hana_allergy"]} | ref [{"tool": "act", "args": {"verb": "edit", "kind": "note", "name": "Hana", "args": "pinned: yes"}}, {"tool": "ask", "args": {"question": "hana's new words or the hana allergies note?", "options": "$hana_words, $hana_allergy"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "hana_allergy", "change": "updated", "fields": {"pinned": true}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "edit", "kind": "note", "name": "Hana", "args": "pinned: yes"}}]`
- **val T23-107#1** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["resin", "resin_old"]} | ref [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "composite resin"}}, {"tool": "ask", "args": {"question": "the one due friday or the july one that's already done?", "options": "$resin, $resin_old"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "resin", "change": "updated", "fields": {"completed": {"any": true}, "status": "completed"}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "composite resin"}}]`
- **val T23-117#1** [R4 applicability]  
  reason: exactly one candidate the verb would change: the runtime acts on it (SPEC 14.1 verb applicability); the ask is replaced  
  old: `{"type": "ask", "candidates": ["elec_06", "elec_07", "elec_08"]} | ref [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Pay electricity"}}, {"tool": "ask", "args": {"question": "june's, july's or august's?", "options": "$elec_06, $elec_07, $elec_08"}}]`  
  new: `{"type": "diff", "diff": {"rows": [{"key": "elec_08", "change": "updated", "fields": {"completed": {"any": true}, "status": "completed"}}], "links": []}} | ref [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Pay electricity"}}]`
- **val T12-076#5** [R4c pick ambiguity (SPEC 3.3c)]  
  reason: the ask is a defensible reading under the narrowed 3.3c (see Notes) and the only one the runtime reaches; candidates derived from the runtime's options  
  old: `{"type": "diff", "diff": {"rows": [{"key": "call_0823", "change": "updated", "fields": {"date": "2026-08-23T21:00"}}], "links": []}} (single accept)`  
  new: `accepts first: {"type": "ask", "candidates": ["call_0719", "call_0823", "call_0802", "call_0906", "call_0705"]}; the previous gold stays accepted`
- **test test-D-065#1** [R4c pick ambiguity (SPEC 3.3c)]  
  reason: the ask is a defensible reading under the narrowed 3.3c (see Notes) and the only one the runtime reaches; candidates derived from the runtime's options  
  old: `{"type": "diff", "diff": {"rows": [{"key": "recital", "change": "updated", "fields": {"duration": 90}}], "links": []}} (single accept)`  
  new: `accepts first: {"type": "ask", "candidates": ["recital"]}; the previous gold stays accepted`
- **test test-C-006#3** [F fail-soft ref ending]  
  reason: ref ends in 'already: Mia is settled up' with the turn still open; v3 passed on the step cap, the runtime now ends the cap as an ask (SPEC 6.3 fail-soft). The ref closes with the balance answer, which gold already accepts (value 0 EUR); gold unchanged  
  old: `ref [{"tool": "act", "args": {"verb": "settle_up", "kind": "person", "name": "Mia", "args": "group: $berlin"}}]`  
  new: `ref [{"tool": "act", "args": {"verb": "settle_up", "kind": "person", "name": "Mia", "args": "group: $berlin"}}, {"tool": "answer", "args": {"kind": "group", "name": "Berlin Flat", "linked_to": "$mia", "op": "balance"}}]`
- **val T12-048#4** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "the plumber" gold `{"type": "diff", "diff": {"rows": [], "links": [{"change": "added", "from": "yearend", "to": "kenta_s"}]}}`  
  new: (turn removed)
- **val T12-105#2** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "the renewal" gold `{"type": "diff", "diff": {"rows": [{"key": "lease_draft", "change": "updated", "fields": {"starred": true}}], "links": []}}`  
  new: (turn removed)
- **val T12-109#2** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "forget it, i'll do it later" gold `{"type": "decline", "reasons": ["never_mind"]}`  
  new: (turn removed)
- **val T12-110#2** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "server key" gold `{"type": "diff", "diff": {"rows": [{"key": "pos_key", "change": "updated", "fields": {"starred": true}}], "links": []}}`  
  new: (turn removed)
- **val T12-130#3** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "the allergies one" gold `{"type": "diff", "diff": {"rows": [{"key": "hana_allergy", "change": "updated", "fields": {"pinned": true}}], "links": []}}`  
  new: (turn removed)
- **val T23-107#2** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "the friday one" gold `{"type": "diff", "diff": {"rows": [{"key": "resin", "change": "updated", "fields": {"status": "completed", "completed": {"any": true}}}], "links": []}}`  
  new: (turn removed)
- **val T23-117#2** [R4 pick turn removed]  
  reason: it existed only to answer or withdraw the ask of the turn before, which now acts  
  old: user "don't bother, i'll pay on click first" gold `{"type": "decline", "reasons": ["never_mind"]}`  
  new: (turn removed)

#### REVIEW BY OWNER

Edits that change a gold VALUE (rows or counts), not an outcome kind. Veto by reverting the turn to the v3 gold:

- val T03-023#3: 'physio by status since september' (an aggregate): tentative count 9 -> 3 (the 6 future physio sessions are outside 'since september up to today'); cancelled 1 unchanged

## Evidence: phase 7 iterations 1 to 3, the soup and nt13 (2026-10-06)

Val (655 sessions, 2,055 turns), greedy, the runtime named per row. Paired comparisons: sessions won / lost, z = (w − l) / √(w + l).

| model | runtime | sessions | clean turns | wrong writes |
| --- | --- | --- | --- | --- |
| p7-r1 (3 epochs, $9.70) | nt7 | 424 (64.7%) | 86.7% | |
| p7-r2 ckpt-100 | nt8 | 467 (71.3%) | | |
| p7-r3, average of ckpt-075 + ckpt-100 (r3a, OLD data) | nt12 replay | 491 | | 41 |
| p7-i2e4 ckpt-100 (NEW data) | nt12 | 489 | | 57 |
| p7-i2e4, average of ckpt-075 + ckpt-100 (i2a) | nt12 | 502 (76.6%) | | 53 |
| soup S1 = r3a + i2a | nt12 | 534 (81.5%); vs i2a +32 (z 3.53), vs r3a +43 (z 4.41) | 93.5% | 45 |
| soup S2 = r3a + i2a + r2 ckpt-100 | nt12 | 537 (82.0%); vs S1 +3 (z 0.48) | 93.7% | 39 |
| soup S3 = r3a 40% + i2a 60% | nt12 | 537; vs S1 +3 (z 0.65) | | 45 |
| S2, recorded run replayed | nt13 | 540 (82.4%) | | |

- **Why the soup works.** r3a and i2a disagree on 131 sessions. S2 keeps 420 of the 431 both pass, wins 95 of the 131 (73%) and recovers 22 of the 93 both fail. From i2's ckpt-100 to S2: same-run averaging +13, a member trained on another data mix +32, a third member +3. The union of six runs passes 591 (90.2%); pass@5 sampling of r3a 528 against its greedy 490; two checkpoints of one run differ on 22 to 31 sessions. The error left is mostly variance: training memorises (98% of natural targets repeat over 3 to 4 epochs).
- **i2's regressions** against r3 (won 71, lost 60, z 0.96): churn, and NEW commits more (row answers 835 → 907, asks 11 → 7, wrong writes 41 → 53); the natural share rose from 50% to 67% and doubled exposure; the dead-end cut teaches a decline after a hint instead of a search. Ruled out: the runtime (1 of the 60 losses), the paraphrase labels (0.16% of targets differ), the new data teaching wrong calls (nearest train neighbours vote OLD's call shape 1.47 against 0.82).
- **S2's 118 failures**: 47 pass in another run, 64 pass in none of six, 30 end in an empty read or a runtime error; worst tags balance values 16/22, repair 42/56, empty 29/37.
- **nt13** (resolve more, guess nothing: B1, B2, R1 to R6; `tests/phase9_nt13.rs`, 823 crate tests): val gold refreezes byte-identical; six train sets verify identically on nt12 and nt13; replay gains S2 +3, S1 +2, i2a +2 sessions, with no session lost by nt13 (every turn that flipped down is a replay artefact: renumbered rows downstream of a newly found row, or a recorded repeat after a now-successful call).
- **Trainer.** `train.py --ema D` keeps an fp32 weight EMA, evaluated on val and saved beside every mark as `ckpt-NNN-ema`; the training is bit-identical with or without it, and a resume carries the shadow (`train/test_ema.py`). `train/soup.py` is the uniform weight average that built S1 to S3 (`train/test_soup.py`).
- Open: the four owner rulings, a live score of S2 on nt13, rollouts and a rejection-sampled run, test at a milestone: `experiments/toolchat/native/HANDOFF.md`.

## Evidence: phase 0 of the next iteration, runtime nt14 and nt15, val v7.4 (2026-10-06)

CPU only; no model was trained or scored live. Replays rescore S2's recorded nt12 run (`eval/replay.py`) under a new runtime and gold.

| step | S2 sessions (655) | note |
| --- | --- | --- |
| recorded run, v7.3 gold | 537 | the nt12 live score |
| recorded run rescored on the N7 refreeze | 541 | `decline-any-reason` widens 124 turns |
| replay on nt14 + N7 | 547 | 11 up, 3 down; the 3 down were an N1 over-reach (ranges and open windows), fixed in nt15 as N1b |
| replay on nt15 + v7.4 | 542 | 14 turns gained for real (T03-121, T03-131, T03-012, C-E010, test-B-060, test-D-010 among them); all 11 sessions down are renumbering artefacts: the new vault lines shift `#n` handles the recorded model wrote |

- **Hard-core audit** of the 63 sessions every model fails (2 readers): model-hard 44, runtime 12, conventions 5, gold 2. Safety finding T03-121: a rejected "2fa" reveal ended with the password revealed in every model; fixed by N4 and R1s.
- **nt14** (ruling 1, N1 to N6, N9; `tests/phase9_nt14.rs`) and **nt15** (R1 to R5, N1b and three follow-ups found by the replay: kind words in R4, R1s only for a field the user named, the R1a hint's scope; `tests/phase9_nt15.rs`): 889 crate tests. Gold of nine train worlds is byte-identical nt13 to nt15 except the reveal error text of two recorded author steps. nt15 changes the system prompt's `act` line (`body+`) and 93 of 5,523 train vault lines, which a replay cannot price: the live score of S2 on nt15 is the open measurement.
- **val v7.4** (sha256 `5d3d9035…`, nt15 sha256 `03a3d3a2…`): 128 turns in 108 sessions gain an accept, none removed (`decline-any-reason` 124, `superlative` 2, `after-series-ask` 1, `group-or-value` 1), UNEXPLAINED 0. G2 audit: of B-E093, D-E127, D-E128, T12-085, T12-092, T23-108 only D-E127 needed the rule; no val turn needed rewording. C1 to C6 contradict no val gold. Rulings: D-1044-16.
- **Data for the rejection-sampled run**: 2,514 fresh sessions (train worlds, rewordings new to training) and 355 skill sessions for the seven model-hard skills (S1 referent 53, S2 units and windows 53, S3 read vs write 54, S4 no invention 47, S5 decline after a miss 53, S6 vocabulary 50, S7 look then pick 45), all verified on nt15; the screen set `eval/sets/roll-screen.jsonl` holds the 2,869.
- **Tooling**: `eval/rollout.py` (screen and sample sets, RFT records and DPO pairs; 33 tests), `train.py --dpo` with a precomputed reference (21 tests) and `bundle.py --continue-from` (1 epoch, lr 4e-6, EMA 0.999), retry on a runtime signal (`NATIVE_RETRY`), opt-in fast kernels and bf16 scoring.
- Open: the live S2 score on nt15, then screen, sample, RFT and DPO, each on the owner's go: `experiments/toolchat/native/HANDOFF.md`.

## Evidence: the merge onto main and #1078 (2026-10-07)

The branch carried #1020 unsquashed, so a plain merge of main conflicted in 413 product files and in none of #1044's. Main (`f5487678`, #1080) is the source of truth, ruled by the owner: its tree was taken whole, #1044's estate kept beside it, and #1044's own product changes re-applied on top. #1078's branch (`claude/ios-app-simulator-aaef2f`: the onboarding deck, the sample vault and the on-device chat) was then merged onto that.

| check | result |
| --- | --- |
| val v7.4 refreeze on the merged runtime | byte-identical (`5d3d9035…`), 655 / 655 sessions, UNEXPLAINED 0, after each merge |
| lines of main the result lacks | 31, each attributed: rung eleven, the field number, the sample refusals, the nudge's removal, re-indentation; 92 more are #1044's clock fixes and manifest surfaces; the rest #1078 removed itself |
| vault DDL | main's plus #1078's chat schema: 115 lines added, none removed |
| workspace tests | all pass but `validate_suite_is_clean_on_all_three_corpora` (s85, DEFECTS.md #B9), red before the merge too |
| grammar derivation | 154 commands, verb classes 100 %; every egress candidate ruled |

- **Main against #1078.** The chat migration is rung eleven (`011_chat.sql`), because main's `010_backup_v2.sql` landed first, and `assist` is envelope field 31, because main's `handoff` holds 23. A sample vault is refused by main's pass and its upload handoff too, and is left out of the iOS upload loop. #1078's "no backup yet" nudge is folded into main's backup line: the field it read, `laptop_paired`, is retired in main's `phone.proto`. R-SAMPLE-8 is recorded in `docs/decisions.md`.
- **Found by the tests, not by the conflicts.** Main's rung-ten and rung-five climb tests rewind a fresh vault, which now holds the chat, so they undo rung eleven first (`common::UNDO_RUNG_ELEVEN`). The registry count gains `chat.*`. #1078's spending-headline test assumed the sample's expenses (four to six days old) sat in last month, which is true only early in a month; it now asks this month and last.
- **Not run here.** The iOS build (no Xcode on Linux) and Android's Compose build. Gradle's Kotlin tests ran through `cargo xtask gate --profile mobile-jvm`; see the commit.

## Evidence: only what S2 depends on, and free decoding (2026-10-07)

Two owner rulings, recorded as D-1044-17 and D-1044-18. The native task (`experiments/toolchat/native`, `crates/nativetools`) imports, reads and builds on none of what was deleted; each cut was held to a baseline taken before it.

| check | result |
| --- | --- |
| lines removed from the branch | 1,202,492 (2,099 files) by the cleanup; about 1,600 more by the grammar cut (Rust 261, the rest Python) |
| the branch's diff against main | +1,766,848 before, +564,361 after the cleanup |
| val v7.4 refreeze | byte-identical (`5d3d9035…`) after the cleanup and again on the cut runtime; 655 / 655 sessions, 2,055 / 2,055 turns, UNEXPLAINED 0; the refreeze report is identical line for line |
| `build_sets.py check` | hashes accepted; the same 9 structural test-redesign failures |
| free decoding, base Qwen3.5-0.8B on CPU, train sessions only | token-identical before and after: 3 first steps (no think closes within 160 tokens), and 12 steps with think limit 0 and the record's own think as the prefix (every one cut, rendered and stopped) |
| `cells.py`'s universe (now read from `metadata.json`, `tools.json`, `prompt.sig.txt` and `kind_card.txt`) | identical but for one reason label, `where.lark:` to `where:` |
| native Python suite, 26 modules | every module keeps its status; 28 grammar tests and 1 soft-mode test removed, 3 free-path tests added; `test_batching` 1,021 s to 59 s |
| `centraid-nativetools` | 887 tests (889 less the 2 grammar-only ones); the 10 export files that remain are byte-identical |
| workspace | `cargo xtask gate --profile local`: every step green (fmt, clippy, test, restore-drill, rules, ledgers), over its 120 s budget on this 4-core box; `--profile mobile-jvm` passes with no fixture drift |

- **What went in the cleanup.**
  - Deleted: the canonical-English harness (`crates/evalsuite`, `crates/evalworld`, `crates/candidates`, `experiments/canon-model`, `joined-*.jsonl`), the toolchat rounds v2 to v8 with their scripts and Kaggle runner, the `afm-spike`, `frontier-probe`, `qwen-mobile` and `qwen-sanity` experiments, and `eval/engineered.py`.
  - Back to main's: the product declarations only that harness read (the manifests' `surface`, `surfaceReason` and `derivedFields`, the registry's `role`, `DECLARED_EFFECTS` and `DECLARED_EGRESS`, `kit/fixtures.rs` `stage_face_proposal`).
  - Kept: the vault's injected-clock fixes and `found_in`, which the runtime uses.
  - The known `validate_suite_is_clean_on_all_three_corpora` red left with `evalsuite`.
- **What went in the grammar cut.**
  - Deleted: the `hard` and `soft` modes, the Lark exports (`call.lark`, `where.lark`, `date_expr.lark`), llguidance and its pins, `train/llama_backend.py` and the llama.cpp arm of `kernel.py` and `bundle.py`, and the `fmt` helpers only the grammar read.
  - Refused: `free` is the only arm `bundle.py` and `kernel.py` accept, and the four removed environment variables are refused rather than ignored.
  - Kept: the think guard, the call rendered from the think, the one-call stop, sampling for rollouts and the compile path.
- **Found on the way, not fixed.** `authored/test_noise.py` has 2 failures from before either cut: six words the nt14 and nt15 rules read in a message are not protected by `authored/noise.py`. It is listed in HANDOFF as the owner's call with the next train build.
