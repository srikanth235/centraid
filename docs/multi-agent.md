# Multi-agent work

How an umbrella issue is executed by one root agent and a set of sub-agents, and the norms that keep parallel agents from spending each other's machine. Each rule names the failure it prevents.

## The shape

- **One umbrella issue, one branch, one draft PR, one receipt.** No child issues. Work is cut into slices; slices are grouped into lanes; lanes run as worktrees in parallel; the merge order of their commits is the wave plan.
- **The root is the brain, not a dispatcher.** It holds the plan's intricacies: ordering, shared files, cross-lane invariants, what "done" means for each slice. Nothing else in the system holds those.
- **Workers own change.** Every edit, commit, gate fix and governance fix is done by a worker in its lane worktree. The root reads, greps, merges lane branches, typechecks, pushes commits that already exist, records rulings.
- **Model split.** The root runs on the strongest model available; workers run on the model the owner names for change-making. The root never spawns a worker on its own model unless the owner says so.

## Lane sizing

A lane is the unit that carries a worker, a worktree, a brief and a merge. Its size is the single most important planning decision, and it is a trade-off with a floor and a ceiling.

### Where the cost goes

Every lane pays a **fixed ceremony cost** whatever its size:

- the root writes the brief and its evidenced State section;
- the worker warms up — the reading set, the traps, the doctrine digest, its first typecheck: tens of thousands of tokens before the first edit;
- the exit list runs at least once end to end, and heavy suites are serialised, so that is wall clock nobody else can use;
- the worker reports, the root reads, verifies, merges, typechecks, pushes.

Every lane also pays a **confusion cost that grows faster than its size**:

- the State section is true at brief time and decays as the lane's own commits change the tree; a long lane ends up working against its own brief;
- the worker's context fills with its own diff and suite output; by the third or fourth gate cycle it re-reads what it already knows or loses what it did;
- every extra file touched widens the exit list, and a wide exit list pulls in inherited red the worker cannot tell from its own;
- restart risk is proportional to wall clock, and the loss on restart is the work since the last commit;
- a lane that grows past its reading set collides with another lane's files, and the root loses parallelism to a merge conflict or a serialisation.

### The floor

A lane is too small when ceremony rivals the work. Signs:

- the brief is longer than the diff it asks for;
- the worker's warmup tokens exceed its change tokens;
- the root merges after every commit;
- the root's tokens on a lane exceed the worker's;
- the same reading set is loaded by successive workers on successive slices.

Fix: keep the worker and add the next slice with the same reading set to its lane. Context carries over; warmup is paid once.

### The ceiling

A lane is too big when the worker cannot hold it. Signs:

- the worker asks the root what the state is, or the State section is wrong by mid-lane because the lane itself changed it;
- the worker edits files outside its reading set;
- the exit list passes fifteen items or pulls in more than two heavy suites;
- the worker's report exceeds its cap because there is too much to say;
- a second restart hits the same lane;
- the lane runs past a working day of wall clock without a merge.

Fix: split at a reading-set seam, or, if the reading set cannot be split, commit at seams inside the lane so each commit is a checkpoint and a merge point, and refresh the State section between commits.

### Sizing rules

1. **The reading set defines the lane.** Start from the files a slice must read, and add slices until either the reading set would have to grow or the ceiling signs appear. Two slices with the same reading set are one lane; two lanes that must touch the same file are one lane.
2. **Warmup should be under a sixth of the lane.** If a worker will spend more than that of its budget reading before it edits, the lane is too small for its reading set: fold in a sibling slice or defer it.
3. **Three to five commits per lane** is the working range. One commit is a slice, not a lane, unless it is atomic (below). Past five, the State section has decayed and the worker's context is mostly its own history.
4. **Commit at every seam.** A commit is the restart checkpoint and the root's merge point. A lane with several small commits is cheaper to recover than one with a single large one.
5. **Parallelism is bounded by verification, not by editing.** Heavy suites run one at a time on this repo's machines, so two or three lanes editing is the useful maximum; more lanes queue on the lock and gain nothing. Plan the count of concurrent lanes from what can be verified in a check-in interval, not from the count of disjoint reading sets.
6. **Atomic slices are the exception to the range.** A change that is only correct as one commit — a plane deletion, a rail move, a schema rewrite — is one lane, one worker, one commit, no budget cap, a milestone note, and an exit list covering every suite that can see the seam. It is never merged in part. Its size is what it is; the rule is to make it the only thing in its lane.
7. **Re-size on evidence.** A lane that shows a ceiling sign is split at the next commit; one that shows a floor sign absorbs the next slice. The wave plan is revised, not defended.

## Roles

### The root does

- Design the plan, size the lanes, and revise both as the code teaches it.
- Write briefs and read reports.
- Merge lane branches into the umbrella branch, typecheck, push.
- Verify claims of absence with its own grep before acting on them.
- Record rulings inline, numbered per wave, with the reason, so a later review can re-judge them.
- Keep a check-in armed until the run's end condition is met.
- Report to the owner: outcome first, numbers in a table, inherited red named, owner items last.

### The root never does

- Edit code or docs, commit, amend, or force-push.
- Commit a worker's uncommitted tree. WIP belongs to the worker that made it.
- Spawn a second worker on a slice that has a live worker.
- Read CI logs or triage CI inside a build run, unless the owner opens a CI lane for it.
- Weaken a gate, budget, ceiling, test or allowlist to get green, or let a worker do so — see [CONSTITUTION.md](../CONSTITUTION.md).

### A worker does

- Read its brief's reading set and doctrine digest before touching code.
- Work only in its lane worktree on its lane branch ([dev-environment.md](dev-environment.md#worktrees), [traps/worktrees.md](traps/worktrees.md)).
- Commit at seams with the umbrella's trailers, the subject within the byte limit and ending with the issue number, and every changed or deleted file named by full path in the receipt.
- Run the slice's exit list, including the push gates, before reporting.
- Keep a milestone note in the worktree (below).
- Report within its cap: what landed (commit id), the exit list line by line with command and result, what it did not do and why, and what it found that is not its slice.

## Planning

### Census before cut

A deletion or replacement slice is never briefed from memory of what depends on the thing. It is preceded by a census — a slice, or a root grep pass — that produces a **numbered exit list**: every consumer by file and symbol, every suite that exercises the old path, every gate the change will trip. The exit list is the brief. Skipping the census turns one lane into a chain of discoveries, each of which stops a worker and costs a round of ceremony.

### Order by evidence, not by hope

A slice starts only when its inputs exist on disk in the umbrella branch. A slice "unblocked by the next merge" is not unblocked. When the owner rules that a slice may open before a measurement, the ruling and the substitute evidence go in the receipt.

## The brief

Every brief carries these sections, in this order.

1. **State, from evidence.** What is true on disk now, each line with the command that proves it and its output. Never from memory, never from the last report. A wrong State line is the commonest reason a worker stops short, and it is always the root's error.
2. **Reading set.** The files and docs the worker reads before editing, and the traps for the area ([traps/](traps/README.md)).
3. **Doctrine digest.** The five to ten repo rules that bite in this area, one line each. Workers do not infer these from the codebase. The governance half is **generated, not typed**: `node .governance/law/brief.mjs` prints every rule in force with its door, severity and statute, the doctrine domains with the decisions they answer to, and the exceptions on the docket. Paste it and stamp the digest it prints. A run under `node .governance/law/run.mjs --brief-digest <digest>` (or `GOVERNANCE_BRIEF_DIGEST`) then says on the front page whether the law moved under the work and which paths moved — the worker is held to HEAD, and the stamp is what names the gap between HEAD and what the worker was told.
4. **The slices**, in order, each with an end state a grep can check.
5. **Exit list.** Numbered; each item a command and its expected result; always ending with the push gates. A slice that cannot be pushed is not done.
6. **Rulings that bind**, by id, one line each.
7. **Report format** and cap.
8. **Recovery.** Where the milestone note lives and what to do on resume.

## Execution

- **Worktrees.** One per lane, sibling to the clone, each with its own `bun install`. The root's own checkout stays clean; a dirty root checkout blocks merges. Worktrees are reused and landed ones deleted — each costs over a gigabyte.
- **Heavy suites are serialised.** Two full suites in parallel on a small machine both time out, so they run through a shared lock. Sibling agents prefer single-file or package-filtered runs (`bunx vitest run path/to/file.test.ts`, `turbo run test --filter=@centraid/<pkg>`) and bail on first failure; the full run belongs to the agent that owns the push. See [dev-environment.md](dev-environment.md#the-local-gate-loop) for which rung runs what.
- **Trust a sibling's reported green.** Do not re-run another agent's suite to be sure, absent evidence of flake or conflict; re-runs thrash CPU and invalidate their timing.
- **Never restart a shared long-running service** — a gateway daemon, Metro, a pairing harness network, a database under a shared `dataDir` — without permission. Stop only what you started, in your own worktree and on your own ports; if you need a port someone else holds, ask or pick another rather than killing by pid.
- **Merge cadence.** The root merges a lane at its check-ins or on owner request, never per commit. Fast-forward when possible; a merge commit when not; never a rebase of a worker's branch.
- **Push gates are part of the slice.** Receipt-per-issue, file-length hygiene and governance run on push. A worker that reports green without running them has not finished; the root sends it back rather than fixing.
- **Doc updates travel with the change.** A worker that learns something outliving its slice updates the doc in the same commit. The close pass catches what slipped; it does not replace this.

### Isolation defaults

| Resource | Rule |
| --- | --- |
| Git worktree | One agent is the primary owner; no force-push to a shared branch without agreement |
| `dataDir` / vault | Per-agent directories |
| Ports | Unique per agent |
| `main` / shared PR branch | Coordinate merges; one agent runs the final push gate |

## Handoff and recovery

The container can restart at any time and kill every worker. Uncommitted work on disk survives; the worker's context does not.

- **Milestone note.** Every worker on a lane longer than one commit keeps an untracked note in its worktree: plan, exit list with boxes, watch-outs, and a dated line per milestone. A note written only at the start describes a plan, and the successor re-derives everything.
- **Resume first.** A stopped worker is resumed with a message. A fresh worker is spawned only when the old one is gone, out of budget, or a resume produces no progress. The fresh worker's first job is the note, `git status`, `git diff --stat`, and a judgement of what on disk is sound.
- **Never commit WIP from the root** to save it. Sound WIP is committed by the next worker; unsound WIP committed is hidden.
- **Check-in.** The root arms a timed check-in for the run's whole life at the interval the owner sets. Nothing changed means re-arm silently. It stops only at the run's end condition.

## Verification

- **A claim names its grep.** "No callers", "all converted", "deleted everywhere" are accepted only with the command and its output. Absence is the claim most often wrong.
- **The root re-checks absence** before it becomes a ruling or a deletion.
- **Conversion is review.** Rewriting a path onto a new grammar exposes latent bugs in the old one. Workers file each as a receipt row, fix it in place when in scope, and hand it to the root when not.
- **Inherited red is measured, not assumed.** Stash onto the branch head, rerun, report the failure-for-failure match. A count of inherited failures is remeasured at every merge; a stale count propagates through briefs.
- **Red-first slices get a verifier.** A separate read-only agent confirms the test fails on the base and passes on the slice before the merge. Every other lane's receipt section ends with a falsification instead: the two riskiest claims in the diff, the throwaway check run against each, and the result. A verifier trusts the worker's gate run when the receipt quotes the tree hash of the landed head and the diff touches no gate, fixture, ratchet, claims or test-kit file, and it messages the worker only on a refuted finding — a message resumes a finished agent and spends its whole context.

## Reporting to the owner

- **Outcome first**, then a table for numbers, then inherited red, then owner items. Never a narrative of the session.
- **ETAs come from the exit list.** Count remaining items, weight suites by measured wall clock, add one round for what the suites find. An ETA from "nearly done" is wrong.
- **Rulings are questions with a recommendation** when reversible: options, a pick, the reason, recorded by id.
- **Token discipline** is the owner's to set and the root's to keep: report cap, check-in interval, whether CI events wake the session, whether CI triage is a lane or the owner's.

## The close pass

Runs once per umbrella, after the last lane lands, and only when the owner opens it. One worker:

1. Doc pass: every touched doc to current state; no text describing the deleted thing; decisions moved from the receipt to the decisions log.
2. Receipt close: the issue's acceptance boxes reconciled one by one, the inherited-red table, corrections to the plan, and the owner hand-offs. The receipt's front page is **generated** — `node .governance/law/run.mjs --front-page <path>`, pasted between its markers — never typed; the next run overwrites anything hand-edited inside it.
3. Dead-code sweep for what the last slice orphaned.
4. PR readiness: body against the issue checklist; draft off; issue body reconciled to what shipped.
5. Owner hand-offs as explicit questions.

## Supervision caps

- One live worker per lane; one root per umbrella.
- Worker report within the owner's cap; brief State section under twenty lines, every line evidenced.
- A worker that stops short twice on the same slice means the brief is wrong. The root rewrites State from grep output before any respawn.
- A lane past five commits without a merge is split, not pushed harder.
- Concurrent lanes never exceed what can be verified in a check-in interval.

| Loop | Cap | Then |
| --- | --- | --- |
| Gate fix cycle | 5 iterations | Escalate to the owner with logs |
| Flaky re-run | 1 retry for infra; **0** "retry until green" for product tests | File the flake as a bug — flaky tests are bugs |
| Review nits | 2 rounds | Batch the rest |
| Tool-call budget | none | A completion requirement instead: dropping a slice is not an outcome; budgeted agents drop slices, unbudgeted ones plan |

## Anti-patterns

| Pattern | Cost | Rule |
| --- | --- | --- |
| Lane per slice with a shared reading set | Warmup paid n times | The reading set defines the lane |
| One lane carrying a whole subsystem | State decays, worker confused, restart loses hours | Ceiling signs, commit at seams |
| More lanes than verification can keep up with | Lanes idle on the lock | Parallelism is bounded by verification |
| State line from memory | Worker stops short | State from evidence |
| Deletion briefed without a census | Serial discoveries, one per round | Census before cut |
| Milestone note written at start only | Successor re-derives the WIP | Dated milestone lines |
| Fresh spawn on a resumable worker | Context lost, duplicate risked | Resume first |
| Inherited red carried unmeasured | Stale count across briefs | Stash and rerun at every merge |
| Push gates outside the exit list | Push blocked, worker round trip | Gates end the list |
| Absence claim taken on trust | Wrong deletion or wrong ruling | The root re-checks absence |

## Related

- [CONSTITUTION.md](../CONSTITUTION.md) — the directives and principles a lane may never weaken to go green
- [dev-environment.md](dev-environment.md) — worktrees, the local gate loop, and how sibling appends to one receipt merge
- [traps/worktrees.md](traps/worktrees.md) — the worktree failures agents hit
- [TESTING.md](../TESTING.md) — the lanes a slice's exit list draws from
- [coding-standards.md](coding-standards.md)
