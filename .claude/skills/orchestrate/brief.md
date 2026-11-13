# Briefs

- The orchestrator decides and answers; implementation goes to nested sessions.
- A brief states the goal, the rulings already made, the files, the git and CI rules (by link to [land/git.md](../land/git.md)), the checks to run and what to report.
- Brief by work-list rows: each row names its locations, its "done when" and the test that proves it, so a report can be read row by row as done or not done.
- Do not fix code a later lane deletes. Say which defects are left on purpose and why.
- Never ask a session to do something that was denied to you or to another session.
- Mockups first. Every behaviour is the same on both platforms. Each part a member sees ends with a `promises.rs` row and shared fixtures.
