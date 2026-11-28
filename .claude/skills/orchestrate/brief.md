# Briefs

The orchestrator decides and answers; implementation goes to nested sessions. A brief states:

- **The goal**, in one or two sentences.
- **The rulings already made.** Link the [product](../product/SKILL.md) skill and the ruling files that apply. Do not restate them, and do not let a session reopen them.
- **The files** to read and the files to change.
- **The work-list rows.** Brief by row: each row names its locations, its "done when" and the test that proves it, so a report can be read row by row as done or not done.
- **The checks to run.** Name the gate profile and commands for this kind of change ([land/gate.md](../land/gate.md)). Git rules: [land/git.md](../land/git.md).
- **How to ask the owner.** Owner questions go to the orchestrator with `send_message` (its session id is in the brief), not left at the end of a turn. Take the safest choice, record it as a decision to review and keep working; stop only for a new dependency, spend or a security question.
- **What to report.** The format in [land/report.md](../land/report.md): commands run, what passed, what was not run, what only CI or a device can verify.

Rules:

- Do not fix code a later lane deletes. Say which defects are left on purpose and why.
- Never ask a session to do something that was denied to you or to another session.
- One area per session where possible. A change across areas is split, with the shared interface written first.
- Mockups first for anything a member sees. Every behaviour is the same on both platforms. Each part a member sees ends with a registry row and shared fixtures.
- Say what is target and what is built, so a session does not build or document the wrong one.
- Spend and new dependencies are not delegated without the owner's go-ahead.
