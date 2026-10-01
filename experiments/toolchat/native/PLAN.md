# Execution plan — fresh build (draft 3)

Everything is built new; past experiment code and data are left untouched. Spec: `SPEC.md`.

| # | step | builds | done when |
| --- | --- | --- | --- |
| 0 | Decisions | SPEC §14 recommendations taken as decisions (2026-09-27) | ✓ done |
| 1 | Runtime | one Rust crate: metadata table, the 8 tools over the real vault, date evaluator, observations, compaction, prompt renderer; exports tool schemas, kind card and grammars | tool tests and repo gate green |
| 2 | Eval | eval worlds; dev 150 and test 300 sessions with gold as effects; the effect scorer and §13 report; Sonnet run on dev as a sanity check of the surface | one review pass (owner spot check of 50 test items is welcome but does not block); Sonnet dev smoke test: no miss left whose cause is gold or runtime |
| 3 | Data | generator driving the runtime: ~7,000 sessions, one sequence each (SPEC §11.7–8, sized from a measured pilot) and 1,000 val | 50 examples hand-read clean |
| 4 | Trainer | SFT trainer, constrained decoding, Kaggle runner, CPU smoke end to end | smoke green |
| 5 | Run 1 | one Kaggle push, ≤ 8 h training, checkpoints at 25/50/100%; score dev, then test once | report |
| 6 | Correction | the model's failures on fresh generated tasks → the policy executor's correct next step → retrain from base; score dev, then test once | test ≥ 90% |

Agents (Opus 5.5): **Runtime** (1), then **Eval** (2) and **Data** (3) in parallel, then **Trainer** (4). Runs 5–6 are driven by the root. If step 6 ends under 90%, the next move is chosen from the dev miss analysis then, not planned now.

Rules: agents build on the runtime crate rather than reimplementing it; they return a short summary and leave artefacts on disk; one Kaggle push per job, checkpoint kept; nothing committed until the owner says.
