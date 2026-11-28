# Review

- Read the diff, not the summary. Read the diff of every risky file: a schema, a trigger, a command, the FFI boundary, a gate or workflow.
- Check each claim in the report against a command that was run. A claim with no command is unverified, and is listed as such.
- Run the checks yourself when the report is thin or the change is risky ([land/gate.md](../land/gate.md)). Read the gate on the newest head and get failures fixed in the code.
- Review every report against the issue, the [product](../product/SKILL.md) skill and the [promises](../product/promises.md). Check the non-goals and the decision process.
- Verify commit authors and subjects yourself.
- Spot-check claims in the code.
- Ask of every schema change: does the database accept what the command refuses? A rule a command states in a sentence is also a constraint or a trigger, and a test writes the bad row with raw SQL.
- Check that nothing target is described as built, and that docs the change made false are fixed.
- Check that no check, test, budget or snapshot was loosened, skipped or deleted.
- Check wording against [design/wording.md](../design/wording.md).
- A session that is told to fix code a later lane deletes is told to leave it ([brief](brief.md)).
- Send it back with the exact failing check or file. Do not fix a session's work silently.
